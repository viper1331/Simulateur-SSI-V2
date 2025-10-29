# Simulateur SSI Catégorie A — FPSSI-like

Ce dépôt contient un monorepo TypeScript (`pnpm`) pour un simulateur pédagogique de SSI Catégorie A aligné sur une expérience FPSSI :

- Serveur Node/Express + Socket.IO + Prisma/SQLite pour l'orchestration temps réel et la journalisation.
- Packages métiers (`@simu-ssi/domain-ssi`, `@simu-ssi/sdk`, `@simu-ssi/shared-ui`, `@simu-ssi/scoring`).
- Applications Vite/React pour le formateur, les apprenants et le studio d'administration.
- Suite de tests Jest/Vitest couvrant les règles industrielles clés.

## Démarrage rapide

```bash
pnpm install
pnpm prisma:generate --filter server
pnpm prisma:migrate dev --filter server
pnpm dev
```

Les serveurs sont exposés par défaut sur :

- API/WS : http://localhost:4500
- Console formateur : http://localhost:5301
- Poste apprenant : http://localhost:5300
- Admin studio : http://localhost:5302

## Tests

```bash
pnpm test
```

Les tests incluent :

- **Jest** pour le noyau métier (`packages/domain-ssi`).
- **Vitest** pour les packages SDK/Scoring et les interfaces Vite.

## Documentation

Des documents sont disponibles dans `simu-ssi/docs` :

- `state-diagrams.md`
- `user-manual-trainer.md`
- `user-manual-trainee.md`
- `scenario-industrie.md`
- `db-schema.md`
