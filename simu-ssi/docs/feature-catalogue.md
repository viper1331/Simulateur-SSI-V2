# Catalogue des fonctionnalités du Simulateur SSI

## Vue d'ensemble
- Monorepo TypeScript géré par `pnpm`, combinant un serveur Node/Express, plusieurs applications Vite/React et des packages métiers dédiés à la simulation FPSSI.【F:README.md†L1-L24】

## Serveur d'orchestration (`apps/server`)
- **Gestion des utilisateurs** : API REST pour lister, créer, modifier, supprimer ou importer en masse les comptes formateurs et stagiaires avec validation des emails et gestion des doublons.【F:simu-ssi/apps/server/src/app.ts†L245-L449】
- **Sessions de formation** : endpoints pour créer, suivre, clôturer et historiser les sessions, avec association formateur/stagiaire, objectifs, notes et génération d'axes d'amélioration.【F:simu-ssi/apps/server/src/app.ts†L451-L608】【F:simu-ssi/apps/server/src/session-manager.ts†L19-L206】
- **Paramétrage du site** : lecture et mise à jour de la configuration SSI (délais DM, déclenchement DAI, besoin d'acquit) et personnalisation du poste apprenant (ordre des modules, panneaux masqués).【F:simu-ssi/apps/server/src/app.ts†L615-L686】
- **Codes d'accès et acquittements** : API pour administrer les codes clavier, vérifier un niveau d'accès, acquitter ou annuler l'acquit process et couper l'audible UGA.【F:simu-ssi/apps/server/src/app.ts†L688-L800】
- **Commandes temps réel** : déclenchement/réarmement DM & DAI, pilotage de l'évacuation manuelle, demande de reset système et mise hors service des équipements, tout en journalisant les événements manuels.【F:simu-ssi/apps/server/src/app.ts†L801-L922】【F:simu-ssi/apps/server/src/manual-call-points.ts†L6-L35】
- **Topologie de site** : diffusion de la cartographie active (incluant l'état "hors service"), contrôle de cohérence des zones et persistance des plans importés depuis le studio.【F:simu-ssi/apps/server/src/app.ts†L975-L1082】
- **Scénarios pédagogiques** : CRUD complet, pré-chargement, exécution, arrêt et complétion avec synchronisation WebSocket et historisation dans le journal.【F:simu-ssi/apps/server/src/app.ts†L1084-L1254】
- **Diffusion temps réel** : Socket.IO notifie état du domaine, scénarios, sessions et topologie à chaque client connecté pour garder les interfaces alignées.【F:simu-ssi/apps/server/src/app.ts†L1256-L1299】
- **Analyse post-session** : génération automatique de pistes d'amélioration à partir du journal d'événements (DM, DAI, évacuation, acquits, reset).【F:simu-ssi/apps/server/src/improvement-generator.ts†L26-L175】

## SDK et bibliothèques partagées
- **`@simu-ssi/sdk`** : schémas Zod pour topologie, scénarios, sessions, dispositions du poste apprenant, plus un client HTTP complet couvrant configuration, utilisateurs, sessions, scénarios, commandes temps réel et publication de topologies.【F:simu-ssi/packages/sdk/src/index.ts†L1-L715】
- **`@simu-ssi/scoring`** : modèle de règles pondérées pour évaluer des événements clés (acquit process, arrêt d'évacuation manuelle) et calculer un score normalisé.【F:simu-ssi/packages/scoring/src/index.ts†L1-L43】
- **`@simu-ssi/shared-ui`** : composants réutilisables pour l'affichage d'indicateurs (StatusTile, TimelineBadge) et la conduite de l'évacuation manuelle avec saisie des motifs.【F:simu-ssi/packages/shared-ui/src/index.ts†L1-L3】【F:simu-ssi/packages/shared-ui/src/manual-evacuation-panel.tsx†L4-L105】【F:simu-ssi/packages/shared-ui/src/status-tile.tsx†L4-L25】【F:simu-ssi/packages/shared-ui/src/timeline-badge.tsx†L3-L29】

## Applications clientes
- **Console formateur** (`apps/trainer-console`) : tableau de bord multi-sections pour suivre CMSI/UGA/DAS, gérer les scénarios (édition, séquençage, audio), piloter l'évacuation manuelle, administrer utilisateurs & sessions, configurer le poste stagiaire et visualiser la cartographie en temps réel.【F:simu-ssi/apps/trainer-console/src/pages/App.tsx†L1-L200】
- **Poste apprenant** (`apps/trainee-station`) : reproduction du pupitre CMSI avec modules configurables, suivi du scénario et des évènements, accès clavier avec niveaux, journal synthétique, instructions pédagogiques et adaptation dynamique selon les contraintes de reset.【F:simu-ssi/apps/trainee-station/src/pages/TraineeApp.tsx†L1-L400】
- **Studio administrateur** (`apps/admin-studio`) : import de plans (drag & drop), placement/renommage des dispositifs FPSSI, gestion des zones, import/export JSON, copie presse-papier et publication directe de la topologie vers le serveur.【F:simu-ssi/apps/admin-studio/src/pages/AdminStudioApp.tsx†L66-L555】

## Flux temps réel et supervision
- WebSocket Server-Side Events relayant mises à jour d'état, scénarios, sessions et topologie à l'ensemble des applications cliente, garantissant une simulation synchronisée pour formateurs et apprenants.【F:simu-ssi/apps/server/src/app.ts†L1256-L1299】

