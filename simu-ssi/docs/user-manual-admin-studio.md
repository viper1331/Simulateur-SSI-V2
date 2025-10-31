# Manuel utilisateur — Studio Administrateur

## Présentation
Le Studio Administrateur permet de préparer graphiquement les sites d'entraînement FPSSI en important des plans
d'exercices, en positionnant les dispositifs (DM, DAI, DAS, UGA) et en documentant les consignes qui seront ensuite
exploitées par les consoles formateur et apprenant. L'interface fonctionne directement dans un navigateur moderne
(Chrome, Edge, Firefox, Safari) et communique avec le serveur Simulateur-SSI via l'URL configurée dans l'application.

## Pré-requis
- Disposer d'un accès au serveur Simulateur-SSI (URL par défaut : `http://localhost:4500`).
- Préparer un plan d'évacuation ou un schéma d'implantation au format image (`.png`, `.jpg`, `.jpeg`, `.svg`).
- Utiliser un navigateur récent avec JavaScript activé.

## Accès à l'application
1. Lancer le serveur Simulateur-SSI (`pnpm --filter server dev` ou via le script de démarrage utilisé habituellement).
2. Depuis la racine du projet, démarrer le Studio Administrateur :
   ```bash
   pnpm --filter admin-studio dev
   ```
3. Ouvrir le navigateur à l'adresse indiquée par Vite (par défaut `http://localhost:5173`).
4. Vérifier que le bandeau supérieur affiche l'URL du serveur connecté.

## Importation d'un plan
1. Cliquer sur **« Choisir un plan »** (ou glisser-déposer directement le fichier image sur la zone centrale).
2. Sélectionner le fichier dans l'explorateur. Les formats PNG, JPG/JPEG et SVG sont acceptés.
3. Le plan s'affiche dans le panneau principal et la liste des dispositifs est vidée afin d'éviter toute incohérence.
4. Pour remplacer le plan, répéter les étapes ci-dessus. Pour repartir de zéro, utiliser le bouton **« Réinitialiser »**.

> Astuce : en cas de plan très volumineux, privilégier une version exportée à l'échelle (ex. 2000 px de large) afin de
> conserver de bonnes performances tout en gardant les détails lisibles.

## Placement des dispositifs
1. Dans la palette de droite, choisir la famille de dispositif à placer (DM, DAI, DAS ou UGA).
2. Le bouton sélectionné reste actif ; cliquer sur le plan à l'endroit souhaité pour déposer un marqueur.
3. Répéter l'opération pour ajouter plusieurs dispositifs du même type. Les libellés sont incrémentés automatiquement
   (DM 1, DM 2, …).
4. Pour changer de type, sélectionner un autre bouton de la palette. Pour désactiver la palette, cliquer de nouveau sur
   le bouton actif.

Chaque marqueur affiche le code du dispositif et peut être survolé pour voir ses coordonnées précises.

## Gestion des dispositifs placés
- **Renommer** : dans la liste, cliquer sur « Renommer » et saisir le libellé souhaité (ex. « DM RDC Nord »).
- **Supprimer** : cliquer sur « Supprimer » pour retirer le dispositif du plan.
- Les coordonnées (en pourcentage de la largeur et de la hauteur du plan) restent visibles pour faciliter le report
  dans les autres outils du simulateur.

## Annotations et consignes
Un bloc « Annotations sur le plan » apparaît dès qu'un plan est importé. Utilisez-le pour décrire :
- Les zones sensibles ou les particularités du bâtiment.
- Les consignes de mise en sécurité à rappeler aux stagiaires.
- Les numéros d'appel utiles, codes d'accès, etc.

Ces notes sont sauvegardées localement dans la session et peuvent être copiées dans les fiches pédagogiques.

## Bonnes pratiques
- Centraliser les différents niveaux du bâtiment dans des plans séparés pour garder une lecture claire.
- Renommer les dispositifs avec des codes cohérents (ex. `DM-RDC-01`) afin de simplifier les échanges avec les
  consoles formateur et apprenant.
- Après chaque modification majeure, réaliser une capture du plan et archiver la configuration avec le scénario
  associé.

## Dépannage
- **Le plan ne s'affiche pas** : vérifier que le fichier est bien une image supportée et qu'il ne dépasse pas les
  limitations de sécurité du navigateur (poids maximal conseillé : < 10 Mo).
- **Impossible de placer un dispositif** : s'assurer qu'un type est sélectionné dans la palette et que le curseur se
  trouve bien sur l'image (et non dans les marges grises autour du plan).
- **Le serveur semble injoignable** : contrôler l'URL indiquée dans le bandeau « Serveur connecté ». Modifier la valeur
  `VITE_SERVER_URL` dans le fichier `.env` du projet si nécessaire.

## Aller plus loin
La prochaine étape consiste à relier le plan et la liste des dispositifs au schéma de topologie FPSSI (zones, scénarios,
modules). Les structures de données exposées par le package `@simu-ssi/sdk` permettent déjà de sérialiser les
informations vers le serveur via son API REST.
