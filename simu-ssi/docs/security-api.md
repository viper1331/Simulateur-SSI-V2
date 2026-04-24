# Sécurité API — fondation P0

Ce document décrit la première couche de sécurité serveur ajoutée au projet.

## Objectif

Mettre en place une base d'authentification non destructive pour protéger les routes API et Socket.IO.

Cette passe fournit :

- un module serveur `apps/server/src/auth.ts` ;
- une gestion de rôles `ADMIN`, `TRAINER`, `TRAINEE` ;
- une authentification par token API ;
- une comparaison de tokens par hash SHA-256 et `timingSafeEqual` ;
- un middleware Express branché dans `app.ts` ;
- un middleware Socket.IO branché dans `app.ts` ;
- des tests unitaires des décisions d'autorisation ;
- une commande déterministe `pnpm security:integrate-auth` pour intégrer les middlewares dans `app.ts` ;
- une commande déterministe `pnpm security:integrate-client-auth` pour propager le token côté SDK/frontends.

## Variables d'environnement

Exemple dans `apps/server/prisma/.env.example` :

```env
SIMU_SSI_AUTH_REQUIRED="false"
SIMU_SSI_API_TOKEN="change-me-admin-token"
SIMU_SSI_API_TOKENS="ADMIN:change-me-admin-token,TRAINER:change-me-trainer-token,TRAINEE:change-me-trainee-token"
VITE_SIMU_SSI_API_TOKEN="change-me-trainer-token"
```

### Comportement serveur

- Si aucun token n'est défini et `SIMU_SSI_AUTH_REQUIRED` n'est pas `true`, la sécurité reste désactivée pour préserver le fonctionnement local.
- Si au moins un token est défini, la sécurité s'active.
- Si `SIMU_SSI_AUTH_REQUIRED="true"` mais qu'aucun token n'est défini, les requêtes protégées répondent `AUTH_NOT_CONFIGURED`.

### Comportement client

- Le SDK peut recevoir `{ apiToken }` à la construction.
- Les frontends Vite peuvent lire `VITE_SIMU_SSI_API_TOKEN`.
- Les requêtes HTTP envoient `Authorization: Bearer <token>`.
- Les connexions Socket.IO envoient le token via `auth.token`.

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

## Intégration serveur automatisée

Depuis la racine `simu-ssi` :

```bash
pnpm security:integrate-auth
```

Après exécution, valider impérativement :

```bash
pnpm --filter server typecheck
pnpm --filter server test
pnpm build
```

## Intégration client automatisée

Depuis la racine `simu-ssi` :

```bash
pnpm security:integrate-client-auth
```

Cette commande :

- ajoute les options `{ apiToken }` au SDK ;
- centralise les appels HTTP du SDK via une méthode `request()` ;
- injecte automatiquement `Authorization: Bearer <token>` ;
- ajoute la lecture de `VITE_SIMU_SSI_API_TOKEN` dans les consoles Vite ;
- transmet le token à Socket.IO via `auth.token`.

Après exécution, valider impérativement :

```bash
pnpm --filter @simu-ssi/sdk typecheck
pnpm --filter trainer-console typecheck
pnpm --filter trainee-station typecheck
pnpm --filter admin-studio typecheck
pnpm build
```

## Côté clients

Les clients HTTP doivent envoyer le token via :

```http
Authorization: Bearer <token>
```

Pour Socket.IO :

```ts
io(baseUrl, {
  auth: {
    token,
  },
});
```

## Prochaine itération

1. Exécuter `pnpm security:integrate-client-auth` dans un environnement local/Codex.
2. Valider typecheck, tests et build.
3. Corriger uniquement les éventuelles erreurs d'intégration.
4. Remplacer ensuite les codes d'accès stockés en clair par des hashes dédiés.
