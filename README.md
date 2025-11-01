# Simulateur SSI Catégorie A — FPSSI-like

Ce dépôt regroupe un monorepo TypeScript (`pnpm`) qui implémente un simulateur pédagogique de SSI Catégorie A fidèle aux pratiques FPSSI.

## Aperçu

- Serveur Node/Express avec Socket.IO et Prisma/SQLite pour orchestrer la simulation en temps réel, conserver l'historique des événements et générer des axes d'amélioration post-session.
- Packages métiers (`@simu-ssi/domain-ssi`, `@simu-ssi/sdk`, `@simu-ssi/shared-ui`, `@simu-ssi/scoring`) factorisant les règles SSI, les composants d'interface et le client HTTP.
- Applications Vite/React distinctes pour le formateur, les apprenants et le studio d'administration.
- Suite de tests Jest/Vitest couvrant les règles industrielles clés et les interfaces critiques.

## Prérequis

- Node.js 18+ et `pnpm` (≥ 8.15.4).
- Prisma CLI (installée via `pnpm`) et SQLite (embarqué par défaut).
- Navigateur récent (Chrome, Edge, Firefox ou Safari) pour les applications web.

## Installation et démarrage rapide

1. Clonez le dépôt puis placez-vous à la racine :
   ```bash
   git clone <votre-url> && cd Simulateur-SSI-V2
   ```
2. Exécutez le script de gestion pour préparer et lancer l'environnement de développement :
   ```bash
   ./simu-ssi/manage.sh start
   ```

Le script `manage.sh` installe les dépendances, génère le client Prisma et lance en parallèle le serveur ainsi que les trois interfaces Vite. Utilisez `./simu-ssi/manage.sh help` pour découvrir toutes les commandes disponibles.

### Initialisation manuelle (alternative)

Si vous préférez piloter chaque étape :

```bash
pnpm install
pnpm prisma:generate
pnpm prisma:migrate dev   # crée/alimente la base SQLite locale
pnpm dev                  # lance serveur + frontends en parallèle
```

### Services exposés

- API & WebSocket : http://localhost:4500
- Console formateur : http://localhost:5301
- Poste apprenant : http://localhost:5300
- Studio administrateur : http://localhost:5302

> Astuce : dans un contexte de production, `pnpm build` puis `pnpm --filter server start` permettent de servir les artefacts compilés.

### Mise à jour des dépendances

```bash
./simu-ssi/manage.sh update
```

Cette commande relance `pnpm install` puis met à jour l'ensemble des workspaces avec `pnpm update --latest`.

## Guide d'utilisation

Les trois interfaces web se synchronisent en temps réel grâce au serveur. Une session type se déroule en quatre étapes :

1. **Préparer la topologie** dans le studio administrateur (import du plan, placement des dispositifs SSI, export ou publication vers le serveur).
2. **Configurer les utilisateurs, sessions et scénarios** depuis la console formateur (import/export JSON, création de scénarios, paramétrage du poste stagiaire).
3. **Animer l'exercice** avec la console formateur (déclenchements scénarisés ou manuels, supervision du CMSI, gestion des évacuations, suivi du journal).
4. **Accompagner les apprenants** sur le poste dédié (accès clavier, réarmement, lecture des instructions, accusés sonores) et exploiter les rapports de session générés automatiquement.

### Console formateur

Accessible sur http://localhost:5301, elle centralise le pilotage pédagogique :

- **Tableau de bord temps réel** : suivi des états CMSI/UGA/DAS, des déclenchements DM/DAI et des équipements hors service via les tuiles `StatusTile` synchronisées par WebSocket.
- **Commandes directes** : boutons pour arrêt signal sonore, acquittement process, demande de réarmement, déclenchement/arrêt de l'évacuation manuelle et réarmement par zone.
- **Scénarios pédagogiques** : création ou import de scénarios, édition visuelle des événements (DM, DAI, audio, resets), préchargement, lancement/arrêt, gestion du mode examen et suivi du statut en cours.
- **Sessions et apprenants** : création des sessions, affectation formateur/stagiaire, saisie des objectifs pédagogiques, import/export JSON d'utilisateurs et consultation des axes d'amélioration générés en fin d'exercice.
- **Paramétrage du poste stagiaire** : personnalisation de l'ordre et de la visibilité des modules du pupitre, des boutons de commande et des panneaux latéraux pour adapter l'exercice.
- **Cartographie** : visualisation détaillée de la topologie publiée (zones, dispositifs DM/DAI/DAS/UGA, statut hors service) avec contrôle de cohérence.
- **Journal d'événements** : flux temps réel listant les dernières actions clés (commandes manuelles, changements d'état, événements scénarisés).

L'interface est entièrement navigable au clavier et expose des attributs ARIA pour les lecteurs d'écran afin de faciliter l'animation inclusive.

### Poste apprenant

Accessible sur http://localhost:5300, il reproduit fidèlement le pupitre CMSI :

- **Façade CMSI interactive** : voyants et libellés reflètent les états feu/maintien/évacuation, avec guides contextuels pour réarmer correctement.
- **Commandes et accès clavier** : authentification par niveaux de code, arrêt du signal sonore, acquittement process et gestion des demandes de reset selon les droits attribués.
- **Simulation UGA et DAS** : retours audio/visuels synchronisés avec les déclenchements réels ou scénarisés, y compris la suspension d'évacuation.
- **Suivi du scénario** : bandeau indiquant l'événement en cours, carte des zones impactées, rappels des contraintes de réarmement et liste des actions déjà réalisées.
- **Panneaux pédagogiques** : récapitulatif des événements, instructions formateur et modules de rappel des procédures, tous ajustables depuis la console formateur.
- **Accessibilité** : navigation clavier complète, contrastes renforcés, messages d'alerte reprenant l'état vocalisé du CMSI pour faciliter l'apprentissage.

### Studio administrateur

Accessible sur http://localhost:5302, il sert à préparer les plans d'entraînement :

- Import ou glisser-déposer de plans au format PNG/JPEG/SVG.
- Placement, renommage et suppression des dispositifs (DM, DAI, DAS, UGA) avec coordonnées normalisées pour garantir la cohérence des scénarios.
- Gestion des zones et états « hors service », export/import JSON des topologies, publication directe vers le serveur pour mise à jour instantanée de la console formateur et du poste apprenant.
- Bloc d'annotations pour documenter consignes, particularités du site et points de vigilance à transmettre aux stagiaires.

### Administration serveur

Le serveur (`pnpm --filter server dev`) expose une API REST documentée dans `@simu-ssi/sdk` permettant d'automatiser la gestion des utilisateurs, sessions, scénarios et topologies. Tous les changements sont diffusés en temps réel via Socket.IO à l'ensemble des clients connectés.

## Maintenance et qualité

- **Tests unitaires et d'intégration** :
  ```bash
  pnpm test
  ```
  Les workspaces exécutent Jest (noyau métier) et Vitest (SDK, scoring, interfaces).
- **Analyse statique et formatage** : `pnpm lint`, `pnpm typecheck`, `pnpm format`.
- **Build** :
  ```bash
  pnpm build
  ```
  Compile l'ensemble des packages et applications pour une mise en production.

## Documentation complémentaire

Le dossier `simu-ssi/docs` contient des ressources détaillées :

- `user-manual-trainer.md` — Manuel complet de la console formateur.
- `user-manual-trainee.md` — Manuel du poste apprenant.
- `user-manual-admin-studio.md` — Studio administrateur pas à pas.
- `feature-catalogue.md` — Catalogue fonctionnel exhaustif.
- `state-diagrams.md`, `scenario-industrie.md`, `db-schema.md` — Schémas de référence.

N'hésitez pas à les consulter pour approfondir un point précis ou préparer vos propres scénarios d'évacuation.
