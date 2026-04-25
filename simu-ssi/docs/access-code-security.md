# Sécurité des codes d'accès

## Objectif

Les codes d'accès ne doivent plus être stockés ni exposés en clair.

Cette évolution remplace le champ `AccessCode.code` par `AccessCode.codeHash` et masque les codes dans les réponses API.

## Changement de modèle

Ancien modèle :

```prisma
model AccessCode {
  level     Int      @id
  code      String   @unique
  updatedAt DateTime @updatedAt
}
```

Nouveau modèle :

```prisma
model AccessCode {
  level     Int      @id
  codeHash  String?
  updatedAt DateTime @updatedAt
}
```

## Migration

La migration `20260425000100_hash_access_codes` reconstruit la table `AccessCode` avec une colonne `codeHash`.

Les anciens codes en clair ne sont pas convertis automatiquement. Ils sont volontairement invalidés car SQLite ne peut pas générer les nouveaux hashes applicatifs `scrypt` de manière sûre pendant la migration.

Après migration, l'administrateur doit redéfinir les codes depuis l'interface ou via l'API `PUT /api/access/codes/:level`.

## API

### GET `/api/access/codes`

La route ne retourne plus les codes réels. Elle retourne uniquement des métadonnées :

```json
{
  "codes": [
    {
      "level": 1,
      "code": "••••",
      "configured": true,
      "updatedAt": "2026-04-25T00:00:00.000Z"
    }
  ]
}
```

### PUT `/api/access/codes/:level`

La route reçoit encore un code en clair côté requête, mais le serveur le transforme immédiatement en hash `scrypt` avant stockage.

### POST `/api/access/verify`

La vérification compare le code saisi avec les hashes existants via `timingSafeEqual`.

## Commande d'intégration

Depuis la racine `simu-ssi` :

```powershell
pnpm security:integrate-hashed-access-codes
```

Puis valider :

```powershell
pnpm prisma:generate
pnpm --filter server typecheck
pnpm --filter @simu-ssi/sdk typecheck
pnpm build
```

## Note importante

Après application de cette migration, les anciens codes doivent être redéfinis. C'est volontaire : cela évite de conserver ou de convertir silencieusement des secrets historiques stockés en clair.
