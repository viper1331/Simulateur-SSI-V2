# Manuel utilisateur — Console formateur

La console formateur permet de superviser et piloter l'ensemble d'un exercice FPSSI : scénarios, évacuation manuelle, paramétrage du poste stagiaire, suivi des sessions et journalisation des événements. Elle est accessible depuis `http://localhost:5301` lorsque l'environnement de développement est lancé.

## Accès et prérequis

1. Démarrez le serveur (`pnpm --filter server dev` ou `./simu-ssi/manage.sh start`).
2. Ouvrez le navigateur sur l'URL fournie par Vite (`http://localhost:5301`).
3. Vérifiez, dans la barre d'état, que la connexion Socket.IO au serveur est active (pastille verte).

> Si la pastille reste grise, assurez-vous que l'API (`http://localhost:4500`) est joignable et que les ports ne sont pas filtrés.

## Navigation principale

Le menu latéral regroupe huit sections. La navigation peut se faire à la souris ou au clavier (`Ctrl` + `←`/`→`).

| Section | Objectif principal |
| --- | --- |
| **Vue d'ensemble** | Synthèse CMSI/UGA/DAS et état général du scénario |
| **Opérations en direct** | Commandes manuelles (arrêt sonore, acquit, reset, évacuation) |
| **Paramètres & accès** | Gestion des codes clavier, niveaux d'accès et configuration du site |
| **Poste apprenant** | Personnalisation de la disposition et des modules du pupitre stagiaire |
| **Cartographie** | Visualisation détaillée de la topologie (zones, dispositifs, hors service) |
| **Scénarios pédagogiques** | Création, import, exécution et suivi des scénarios |
| **Sessions & apprenants** | Gestion des sessions de formation, affectations et objectifs |
| **Journal d'événements** | Historique temps réel des derniers événements |

## Tableau de bord temps réel

La section **Vue d'ensemble** affiche :

- Des tuiles `StatusTile` pour les états CMSI, UGA, DAS et évacuation manuelle.
- Les chronogrammes en cours (zones et déclencheurs associés) avec horodatage.
- Les derniers DM/DAI activés, leur zone et le temps écoulé depuis le déclenchement.

Survoler une tuile affiche le détail de la source (scénario ou action manuelle).

## Commandes immédiates

Dans **Opérations en direct** :

- **Arrêt signal sonore** coupe l'UGA et demande la confirmation d'un opérateur habilité.
- **Acquittement process** valide la prise en compte des alarmes en cours.
- **Demande de réarmement** lance la procédure de reset du CMSI (un bandeau indique lorsqu'il faut confirmer côté apprenant).
- **Commande évacuation manuelle** déclenche ou interrompt l'évacuation générale. Un formulaire facultatif permet de consigner le motif.
- **Réarmement DM/DAI par zone** réinitialise uniquement la zone ciblée (utile après un déclenchement scénarisé).

Chaque action est journalisée et diffusée instantanément aux postes connectés.

## Paramètres du site et codes d'accès

La section **Paramètres & accès** permet de :

- Ajuster les délais DM/DAI, le comportement de l'acquit process et la présence d'un accusé sonore local.
- Gérer les codes clavier des niveaux 2 et 3 (création, modification, consultation des dernières mises à jour).

Toute modification est persistée via l'API et appliquée immédiatement.

## Personnalisation du poste stagiaire

Dans **Poste apprenant**, adaptez l'interface pour vos stagiaires :

1. Réordonner les modules de la façade (DM ZF1-8, CMSI, DAS, etc.).
2. Choisir les boutons de commande visibles (arrêt sonore, acquit, évacuation manuelle…).
3. Activer/désactiver les panneaux latéraux (journal synthétique, instructions, session, accès clavier).
4. Sauvegarder le layout pour qu'il soit appliqué en direct aux postes apprenants.

Un aperçu en direct montre le rendu final.

## Cartographie du site

La section **Cartographie** synchronise la topologie importée depuis le studio administrateur :

- Les dispositifs sont regroupés par zone (ZF, ZD, ZS) avec coordonnées affichées et badges de type.
- Les zones dépourvues de dispositifs sont signalées pour faciliter les compléments dans l'Admin Studio.
- Les dispositifs sans zone sont listés à part afin d'être corrigés avant la session.

## Gestion des scénarios

Dans **Scénarios pédagogiques** :

1. **Créer ou importer** : démarrer d'un scénario vierge, dupliquer un modèle ou importer un fichier JSON exporté.
2. **Éditer la chronologie** : ajouter des événements (DM, DAI, audio, évacuation manuelle, acquits, resets) avec offsets et durée.
3. **Associer des plans et médias** : rattacher la topologie du site et charger des sons d'évacuation automatique ou manuelle.
4. **Configurer le mode de réarmement** : réarmement total, partiel ou sélectif avec contraintes spécifiques.
5. **Précharger** un scénario pour préparer un exercice et vérifier la cohérence.
6. **Lancer/stopper** l'exécution ; l'état courant (prêt, en cours, terminé, en attente de reset) est affiché en temps réel.
7. **Consulter les axes d'amélioration** générés en fin de scénario (arrêts tardifs, acquits manquants, etc.).

Les événements planifiés sont poussés automatiquement vers les postes apprenants et journalisés.

## Sessions et suivi des stagiaires

La section **Sessions & apprenants** offre :

- Création d'une session avec titre, objectif, mode et formateur associé.
- Affectation de stagiaires existants ou import/export JSON (fichiers produits par la console) pour maintenir le référentiel utilisateurs.
- Suivi en direct du statut (en préparation, en cours, clôturée) et de la présence des stagiaires connectés.
- Saisie de notes qualitatives après la session et accès aux axes d'amélioration calculés automatiquement.

## Journal d'événements

Le **Journal d'événements** affiche en continu la chronologie condensée des derniers faits marquants (déclenchements, acquits, changements de mode). Chaque entrée reprend l'horodatage et la description fournie par le serveur.

## Accessibilité

- Toutes les commandes sont atteignables au clavier (tabulation) et décrites par des attributs ARIA pour les lecteurs d'écran.
- Les retours d'état incluent des messages textuels pour faciliter le suivi sans support visuel permanent.

## Dépannage

- **Pas de connexion au serveur** : vérifier que le service `apps/server` tourne et que `VITE_SERVER_URL` pointe vers l'URL correcte.
- **Scénario bloqué en attente de reset** : demander au stagiaire de confirmer la procédure sur le poste apprenant ou utiliser la commande de reset global.
- **Import JSON échoué** : vérifier que le fichier respecte la structure exportée par la console (schéma `UserImportPayload`).

En cas de problème persistant, consultez les logs du serveur (`apps/server`) pour identifier l'erreur remontée.
