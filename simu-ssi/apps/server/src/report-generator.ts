import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { prisma } from './prisma';
import { createLogger, toError } from './logger';

const improvementSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
});

type ImprovementArea = z.infer<typeof improvementSchema>;

type SessionReportContext = {
  id: string;
  name: string;
  mode: string;
  objective: string | null;
  notes: string | null;
  startedAt: Date;
  endedAt: Date | null;
  trainee?: { id: string; fullName: string; email: string | null } | null;
  trainer?: { id: string; fullName: string; email: string | null } | null;
  improvements: ImprovementArea[];
  events: Array<{
    ts: Date;
    source: string;
    message: string | null;
    zoneId: string | null;
    details: Record<string, unknown> | null;
  }>;
  scores: Array<{
    value: number;
    rubric: Record<string, unknown> | null;
    comments: string | null;
    scorer: { id: string | null; fullName: string | null };
  }>;
};

const REPORT_LOGGER = createLogger('SessionReport');

const BASE_REPORT_DIR = process.env.SESSION_REPORTS_DIR
  ? path.resolve(process.env.SESSION_REPORTS_DIR)
  : path.resolve(process.cwd(), 'reports');

export async function generateSessionReport(sessionId: string): Promise<string | null> {
  try {
    const context = await buildContext(sessionId);
    if (!context) {
      REPORT_LOGGER.warn("Impossible de générer le rapport : session introuvable", { sessionId });
      return null;
    }
    const traineeDir = await resolveTraineeDirectory(context);
    await fs.mkdir(traineeDir, { recursive: true });
    const filename = buildReportFilename(context);
    const filePath = path.join(traineeDir, filename);
    await writePdfReport(context, filePath);
    REPORT_LOGGER.info('Rapport de session généré', { sessionId, filePath });
    return filePath;
  } catch (error) {
    REPORT_LOGGER.error('Échec de génération du rapport de session', { sessionId, error: toError(error) });
    return null;
  }
}

async function buildContext(sessionId: string): Promise<SessionReportContext | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      trainee: true,
      trainer: true,
      scores: { include: { user: true } },
      events: { orderBy: { ts: 'asc' } },
    },
  });
  if (!session) {
    return null;
  }
  return {
    id: session.id,
    name: session.name,
    mode: session.mode,
    objective: session.objective ?? null,
    notes: session.notes ?? null,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    trainee: session.trainee
      ? { id: session.trainee.id, fullName: session.trainee.fullName, email: session.trainee.email ?? null }
      : null,
    trainer: session.trainer
      ? { id: session.trainer.id, fullName: session.trainer.fullName, email: session.trainer.email ?? null }
      : null,
    improvements: parseImprovements(session.improvementJson),
    events: session.events.map((event) => ({
      ts: event.ts,
      source: event.source,
      message: event.message ?? null,
      zoneId: event.zoneId ?? null,
      details: parseJson(event.payloadJson),
    })),
    scores: session.scores.map((score) => ({
      value: score.value,
      rubric: parseJson(score.rubricJson),
      comments: score.comments ?? null,
      scorer: { id: score.user?.id ?? null, fullName: score.user?.fullName ?? null },
    })),
  };
}

async function resolveTraineeDirectory(context: SessionReportContext): Promise<string> {
  if (context.trainee) {
    const normalizedName = normalizeName(context.trainee.fullName).replace(/\s+/g, '_');
    const shortId = context.trainee.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    const directoryName = shortId ? `${normalizedName}_${shortId}` : normalizedName;
    return path.join(BASE_REPORT_DIR, directoryName);
  }
  return path.join(BASE_REPORT_DIR, 'apprenant_inconnu');
}

function buildReportFilename(context: SessionReportContext): string {
  const endedAt = context.endedAt ?? new Date();
  const dateStamp = formatForFilename(endedAt);
  const slug = normalizeName(context.name).replace(/\s+/g, '-').toLowerCase();
  return `rapport_${dateStamp}_${slug || 'session'}.pdf`;
}

async function writePdfReport(context: SessionReportContext, filePath: string): Promise<void> {
  const doc = new PDFDocument({ margin: 50 });
  const stream = createWriteStream(filePath);
  doc.pipe(stream);

  doc.font('Helvetica-Bold').fontSize(20).text('Rapport de session', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).font('Helvetica');

  doc.text(`Session : ${context.name}`);
  doc.text(`Mode : ${context.mode}`);
  doc.text(`Début : ${formatDateTime(context.startedAt)}`);
  doc.text(`Fin : ${context.endedAt ? formatDateTime(context.endedAt) : 'Non renseignée'}`);
  doc.moveDown();

  doc.font('Helvetica-Bold').text('Participants');
  doc.font('Helvetica').moveDown(0.2);
  doc.text(`Formateur : ${formatUser(context.trainer)}`);
  doc.text(`Apprenant : ${formatUser(context.trainee)}`);
  doc.moveDown();

  if (context.objective || context.notes) {
    doc.font('Helvetica-Bold').text('Objectif & notes');
    doc.font('Helvetica').moveDown(0.2);
    if (context.objective) {
      doc.text(`Objectif : ${context.objective}`);
    }
    if (context.notes) {
      doc.moveDown(0.2);
      doc.text('Notes de session :');
      doc.moveDown(0.1);
      doc.font('Helvetica').text(context.notes, { indent: 15, lineGap: 2 });
    }
    doc.moveDown();
  }

  doc.font('Helvetica-Bold').text('Axes d’amélioration');
  if (context.improvements.length === 0) {
    doc.font('Helvetica').moveDown(0.2).text('Aucun axe renseigné.');
  } else {
    doc.font('Helvetica').moveDown(0.2);
    context.improvements.forEach((improvement, index) => {
      doc.font('Helvetica-Bold').text(`${index + 1}. ${improvement.title}`);
      if (improvement.description) {
        doc.font('Helvetica').text(improvement.description, { indent: 15, lineGap: 2 });
      }
      doc.moveDown(0.3);
    });
  }
  doc.moveDown();

  if (context.scores.length > 0) {
    doc.font('Helvetica-Bold').text('Évaluations');
    doc.font('Helvetica').moveDown(0.2);
    context.scores.forEach((score, index) => {
      const scorer = score.scorer.fullName ? `${score.scorer.fullName}` : 'Évaluateur inconnu';
      doc.font('Helvetica-Bold').text(`Évaluation ${index + 1} – ${scorer}`);
      doc.font('Helvetica').text(`Note : ${score.value.toFixed(2)}`);
      if (score.comments) {
        doc.text(`Commentaire : ${score.comments}`, { indent: 15, lineGap: 2 });
      }
      if (score.rubric) {
        doc.text('Détails de la grille :');
        doc.text(formatDetails(score.rubric), { indent: 15 });
      }
      doc.moveDown(0.4);
    });
    doc.moveDown();
  }

  doc.font('Helvetica-Bold').text('Chronologie des événements');
  if (context.events.length === 0) {
    doc.font('Helvetica').moveDown(0.2).text('Aucun événement enregistré durant la session.');
  } else {
    doc.moveDown(0.2);
    context.events.forEach((event, index) => {
      doc.font('Helvetica-Bold').text(`${index + 1}. ${formatDateTime(event.ts)} – ${event.source}`);
      doc.font('Helvetica').text(event.message ?? 'Aucun message détaillé.');
      if (event.zoneId) {
        doc.text(`Zone : ${event.zoneId}`);
      }
      if (event.details) {
        doc.text('Détails :');
        doc.text(formatDetails(event.details), { indent: 15 });
      }
      doc.moveDown(0.4);
    });
  }

  doc.end();
  await finished(stream);
}

function formatUser(user?: { fullName: string; email: string | null } | null): string {
  if (!user) {
    return 'Non renseigné';
  }
  if (user.email) {
    return `${user.fullName} (${user.email})`;
  }
  return user.fullName;
}

function parseImprovements(json: string | null): ImprovementArea[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => improvementSchema.safeParse(item))
      .filter((result): result is { success: true; data: ImprovementArea } => result.success)
      .map((result) => result.data);
  } catch (error) {
    REPORT_LOGGER.warn('Impossible de parser les axes d’amélioration', { error: toError(error) });
    return [];
  }
}

function parseJson<T = Record<string, unknown>>(value: string | null): T | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    REPORT_LOGGER.warn('Impossible de parser des données JSON', { error: toError(error) });
    return null;
  }
}

function normalizeName(value: string): string {
  const stripped = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || 'session';
}

function formatForFilename(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${hh}${min}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'full',
  timeStyle: 'short',
});

function formatDateTime(date: Date): string {
  return dateTimeFormatter.format(date);
}

function formatDetails(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
