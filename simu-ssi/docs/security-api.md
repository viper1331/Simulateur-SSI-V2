# Sécurité API — fondation P0

Ce document décrit la première couche de sécurité serveur ajoutée au projet.

## Objectif

Mettre en place une base d'authentification non destructive pour préparer la protection des routes API et Socket.IO.

Cette passe fournit :

- un module serveur `apps/server/src/auth.ts` ;
- une gestion de rôles `ADMIN`, `TRAINER`, `TRAINEE` ;
- une authentification par token API ;
- une comparaison de tokens par hash SHA-256 et `timingSafeEqual` ;
- un middleware Express prêt à brancher ;
- un middleware Socket.IO prêt à brancher ;
- des tests unitaires des décisions d'autorisation ;
- une commande déterministe `pnpm security:integrate-auth` pour intégrer les middlewares dans `app.ts`.

## Variables d'environnement

Exemple dans `apps/server/prisma/.env.example` :

```env
SIMU_SSI_AUTH_REQUIRED="false"
SIMU_SSI_API_TOKEN="change-me-admin-token"
SIMU_SSI_API_TOKENS="ADMIN:change-me-admin-token,TRAINER:change-me-trainer-token,TRAINEE:change-me-trainee-token"
```

### Comportement

- Si aucun token n'est défini et `SIMU_SSI_AUTH_REQUIRED` n'est pas `true`, la sécurité reste désactivée pour préserver le fonctionnement local.
- Si au moins un token est défini, la sécurité s'active.
- Si `SIMU_SSI_AUTH_REQUIRED="true"` mais qu'aucun token n'est défini, les requêtes protégées répondent `AUTH_NOT_CONFIGURED`.

## Rôles

| Rôle | Droits prévus |
| --- | --- |
| `ADMIN` | Administration complète, configuration, utilisateurs, codes d'accès |
| `TRAINER` | Pilotage pédagogique, sessions, scénarios, topologie, commandes de simulation |
| `TRAINEE` | Lecture et accès apprenant limité |

## Matrice de routes actuelle

| Routes | GET | POST/PUT/DELETE |
| --- | --- | --- |
| `/api/access/verify` | `ADMIN`, `TRAINER`, `TRAINEE` | `ADMIN`, `TRAINER`, `TRAINEE` |
| `/api/access/codes*` | `ADMIN` | `ADMIN` |
| `/api/users*` | `ADMIN`, `TRAINER` | `ADMIN` |
| `/api/config*` | `ADMIN`, `TRAINER` | `ADMIN` |
| `/api/topology*` | `ADMIN`, `TRAINER`, `TRAINEE` | `ADMIN`, `TRAINER` |
| `/api/sessions*` | `ADMIN`, `TRAINER`, `TRAINEE` | `ADMIN`, `TRAINER` |
| `/api/scenarios*` | `ADMIN`, `TRAINER`, `TRAINEE` | `ADMIN`, `TRAINER` |
| `/api/evac*`, `/api/process*`, `/api/uga*`, `/api/sdi*`, `/api/devices*`, `/api/zones*`, `/api/system*` | `ADMIN`, `TRAINER` | `ADMIN`, `TRAINER` |

## Intégration automatisée

Depuis la racine `simu-ssi` :

```bash
pnpm security:integrate-auth
```

Cette commande modifie `apps/server/src/app.ts` de manière déterministe pour ajouter :

```ts
import { createApiAuthMiddleware, createSocketAuthMiddleware, getAuthConfig } from './auth';
```

puis :

```ts
const authConfig = getAuthConfig();
app.use('/api', createApiAuthMiddleware(authConfig));
```

et après création de l'instance Socket.IO :

```ts
io.use(createSocketAuthMiddleware(authConfig));
```

Après exécution, valider impérativement :

```bash
pnpm --filter server typecheck
pnpm --filter server test
pnpm build
```

## Intégration manuelle équivalente

Dans `apps/server/src/app.ts`, importer :

```ts
import { createApiAuthMiddleware, createSocketAuthMiddleware, getAuthConfig } from './auth';
```

Puis, après `express.json(...)` et avant les routes `/api/*` :

```ts
const authConfig = getAuthConfig();
app.use('/api', createApiAuthMiddleware(authConfig));
```

Après création de l'instance Socket.IO :

```ts
io.use(createSocketAuthMiddleware(authConfig));
```

## Côté clients

Les clients devront envoyer le token via :

```http
Authorization: Bearer <token>
```

ou :

```http
x-api-key: <token>
```

Pour Socket.IO, le token pourra être transmis via :

```ts
io(baseUrl, {
  auth: {
    token,
  },
});
```

## Prochaine itération

1. Exécuter `pnpm security:integrate-auth` dans un environnement local/Codex.
2. Valider typecheck, tests et build.
3. Ajouter la gestion du token dans `@simu-ssi/sdk`.
4. Ajouter une configuration front `VITE_SIMU_SSI_API_TOKEN` pour les usages de laboratoire.
5. Remplacer ensuite les codes d'accès stockés en clair par des hashes dédiés.
