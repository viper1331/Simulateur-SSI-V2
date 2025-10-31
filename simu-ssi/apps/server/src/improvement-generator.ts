import type { ImprovementArea } from './session-manager';
import { prisma } from './prisma';

interface NormalizedEvent {
  source: string;
  eventType?: string;
  zoneId?: string;
}

function parsePayload(json: string | null): Record<string, unknown> | null {
  if (!json) {
    return null;
  }
  try {
    const value = JSON.parse(json);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch (error) {
    console.error('Failed to parse event payload JSON', error);
    return null;
  }
}

export async function generateImprovementAreasForSession(sessionId: string): Promise<ImprovementArea[]> {
  const events = await prisma.eventLog.findMany({
    where: { sessionId },
    orderBy: { ts: 'asc' },
  });

  if (events.length === 0) {
    return [];
  }

  const normalizedEvents: NormalizedEvent[] = events.map((event) => {
    const payload = parsePayload(event.payloadJson);
    const eventType = typeof payload?.event === 'string' ? payload.event : undefined;
    const zoneId = typeof payload?.zoneId === 'string' ? payload.zoneId : undefined;
    return { source: event.source, eventType, zoneId };
  });

  const dmLatched = new Set<string>();
  const dmReset = new Set<string>();
  const daiTriggered = new Set<string>();
  const daiReset = new Set<string>();
  let manualEvacStarted = false;
  let manualEvacStopped = false;
  let automaticEvacStarted = false;
  let processAckReceived = false;
  let evacuationPending = false;
  let audibleSilenced = false;
  let systemReset = false;

  for (const event of normalizedEvents) {
    switch (event.eventType) {
      case 'DM_LATCHED':
        if (event.zoneId) {
          dmLatched.add(event.zoneId);
        }
        break;
      case 'DM_RESET':
        if (event.zoneId) {
          dmReset.add(event.zoneId);
        }
        break;
      case 'DAI_TRIGGERED':
        if (event.zoneId) {
          daiTriggered.add(event.zoneId);
        }
        break;
      case 'DAI_RESET':
        if (event.zoneId) {
          daiReset.add(event.zoneId);
        }
        break;
      case 'MANUAL_EVAC_STARTED':
        manualEvacStarted = true;
        break;
      case 'MANUAL_EVAC_STOPPED':
        manualEvacStopped = true;
        break;
      case 'AUTOMATIC_EVAC_STARTED':
        automaticEvacStarted = true;
        break;
      case 'PROCESS_ACK':
        processAckReceived = true;
        break;
      case 'EVAC_PENDING':
        evacuationPending = true;
        break;
      case 'AUDIBLE_SILENCED':
        audibleSilenced = true;
        break;
      case 'SYSTEM_RESET':
        systemReset = true;
        break;
      default:
        break;
    }
  }

  const dmOutstanding = Array.from(dmLatched).filter((zone) => !dmReset.has(zone));
  const daiOutstanding = Array.from(daiTriggered).filter((zone) => !daiReset.has(zone));
  const evacuationStarted = manualEvacStarted || automaticEvacStarted;

  const zoneIds = new Set([...dmOutstanding, ...daiOutstanding]);
  const zoneLabels = new Map<string, string>();
  if (zoneIds.size > 0) {
    const zones = await prisma.zone.findMany({ where: { id: { in: Array.from(zoneIds) } } });
    for (const zone of zones) {
      zoneLabels.set(zone.id, zone.label);
    }
  }

  const formatZoneList = (zones: string[]) =>
    zones
      .map((zoneId) => zoneLabels.get(zoneId) ?? zoneId)
      .join(', ');

  const improvements: ImprovementArea[] = [];

  if (evacuationPending && !processAckReceived) {
    improvements.push({
      title: "Acquitter le processus d'alarme",
      description:
        "Aucun acquittement n'a été enregistré pendant la phase d'alarme. Pensez à utiliser le bouton d'acquittement pour suspendre l'évacuation automatique.",
    });
  }

  if (dmOutstanding.length > 0) {
    improvements.push({
      title: 'Réarmer les déclencheurs manuels',
      description: `Les DM suivants sont restés enclenchés : ${formatZoneList(dmOutstanding)}. Assurez-vous de réaliser la levée de doute et de les réarmer.`,
    });
  }

  if (daiOutstanding.length > 0) {
    improvements.push({
      title: 'Réinitialiser les détecteurs automatiques',
      description: `Les détecteurs ${formatZoneList(daiOutstanding)} n'ont pas été réarmés. Vérifiez la zone concernée et procédez à la réinitialisation.`,
    });
  }

  if (manualEvacStarted && !manualEvacStopped) {
    improvements.push({
      title: "Clôturer l'évacuation manuelle",
      description: "L'évacuation manuelle a été déclenchée mais aucun arrêt n'a été détecté. Veillez à arrêter l'évacuation une fois la situation maîtrisée.",
    });
  }

  if (evacuationStarted && !audibleSilenced) {
    improvements.push({
      title: 'Couper le signal sonore',
      description: "Le signal sonore est resté actif jusqu'à la fin du scénario. Pensez à le couper après la mise en sécurité du site.",
    });
  }

  if ((dmOutstanding.length > 0 || daiOutstanding.length > 0 || evacuationStarted) && !systemReset) {
    improvements.push({
      title: "Remettre le SSI à l'état de repos",
      description:
        "Le système n'a pas été réarmé en fin de scénario. Vérifiez que tous les équipements sont rétablis puis effectuez la remise à zéro du SSI.",
    });
  }

  return improvements.slice(0, 5);
}
