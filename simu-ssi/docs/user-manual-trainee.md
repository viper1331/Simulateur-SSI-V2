# Manuel utilisateur — Poste apprenant

Le poste apprenant simule une façade CMSI complète, l'UGA et les retours DAS pour permettre aux stagiaires de s'entraîner à reconnaître les états du système et à appliquer les procédures de sécurité. L'application web est accessible sur `http://localhost:5300`.

## Connexion et synchronisation

1. Démarrez l'environnement (`./simu-ssi/manage.sh start` ou `pnpm dev`).
2. Ouvrez le poste apprenant dans un navigateur moderne.
3. Vérifiez le bandeau supérieur : il affiche l'état de connexion au serveur et le nom de la session active.

Si le bandeau indique « Déconnecté », confirmez que le serveur (`http://localhost:4500`) est accessible et que la console formateur est bien connectée.

## Lecture de la façade CMSI

La façade principale est organisée en modules :

- **État CMSI** : un cartouche central affiche les statuts feu, maintien, évacuation et préalarme. Lorsque l'état change, un message contextuel décrit l'action attendue.
- **Tuiles DM ZF1-8** : indiquent les zones en alarme ou réarmées. Un badge rouge signale un déclenchement en cours.
- **Tuiles DAI et DAS** : montrent l'activité des détecteurs automatiques et des actionneurs de sécurité.
- **UGA & audible local** : précisent si la diffusion sonore est active et s'il reste un signal local à couper.

Survoler une tuile ou appuyer sur `Enter` lorsque la tuile a le focus donne accès aux détails (zone, horodatage, origine scénario/manuelle).

## Commandes clavier et accès

- **Authentification** : cliquez sur « Saisir un code » et entrez le code fourni par le formateur. Le niveau d'accès acquis est rappelé dans le bandeau.
- **Arrêt signal sonore** : accessible dès le niveau 1 pour couper l'UGA. Un message confirme la réussite.
- **Acquittement process** : bouton actif si la procédure est requise. Le CMSI passe alors en état acquitté.
- **Demande de réarmement** : disponible lorsque les conditions de reset sont réunies. Le bouton reste grisé tant que des DM/DAI sont actifs.
- **Réarmement local** : certaines zones nécessitent un réarmement manuel (DM, DAI). Utilisez la grille pour valider chaque zone à la demande du formateur.

Les commandes sont également accessibles au clavier (`Tab` pour naviguer, `Espace` ou `Enter` pour activer). Les lecteurs d'écran reçoivent une description ARIA de chaque contrôle.

## Bandeau scénario et instructions

En haut de l'écran :

- Le **bandeau scénario** indique le statut (`Mode libre`, `Scénario prêt`, `Scénario en cours`, `En attente de réarmement`, etc.) et décrit l'action suivante attendue (ex. « DM ZF2 », « Réarmement DAI », « Début évacuation manuelle »).
- Le **compteur de contraintes** rappelle les zones à vérifier avant un reset.
- Les **instructions formateur** s'affichent dans un panneau latéral pour guider le stagiaire (procédures, objectifs, consignes particulières).

## Journal synthétique

Le panneau « Récapitulatif évènementiel » liste les actions récemment effectuées :

- Horodatage relatif (« il y a 30 s », « il y a 2 min »).
- Source (scénario, formateur, stagiaire, système).
- Commentaire éventuel du formateur.

Utilisez les flèches haut/bas pour faire défiler les entrées lorsque le focus est dans le panneau.

## Visualisation de la cartographie

Si le formateur a publié une topologie, deux vues complémentaires sont proposées :

1. **Écran LED interactif** : navigation sous forme d'arborescence (zones, dispositifs) avec la possibilité, pour les niveaux d'accès ≥ 2, de basculer l'état « hors service » d'un équipement simulé.
2. **Plan simplifié** : représentation graphique du site avec marqueurs DM/DAI/DAS/UGA.

Les éléments notables :

- Zones en rouge/orange lorsque des DM/DAI sont actifs.
- Dispositifs hors service grisés et clairement identifiés.
- Numéros de zone correspondant aux consignes partagées.

Ces vues aident à localiser rapidement les déclenchements pendant l'exercice et à appliquer les procédures de maintenance simulées.

## Accessibilité et aide

- Navigation au clavier (tabulation, `Enter`/`Espace`) sur l'ensemble des commandes.
- Messages textuels et pictogrammes renforcés pour signaler les transitions critiques.
- Un mode contraste renforcé s'active automatiquement lorsque l'état `Évacuation` est détecté.

## Dépannage

- **Les voyants restent inactifs** : vérifier la connexion réseau et demander au formateur de republier la topologie.
- **Impossible de saisir un code** : confirmer que le formateur a bien créé le code (section « Paramètres & accès » de la console formateur).
- **Bouton de reset grisé** : contrôler la liste des zones dans le bandeau de contraintes ; chaque zone doit être réarmée manuellement ou via le scénario.

En cas de doute, consultez le formateur ou les logs navigateur (`F12 > Console`) pour identifier une erreur de connexion.
