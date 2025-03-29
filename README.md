# Redis Threading

Une bibliothèque robuste de multithreading pour Node.js/TypeScript utilisant Redis comme support pour la communication, la synchronisation et la mise en file d'attente des tâches.

## Caractéristiques

- **Pool de Workers** - Gestion efficace de worker threads pour les calculs parallèles
- **File d'Attente Distribuée** - Distribution et synchronisation des tâches via Redis
- **Communication Inter-Processus** - Communication Pub/Sub entre les nœuds
- **État Partagé** - Partage de données entre les processus avec notifications de changement
- **Verrous Distribués** - Synchronisation de sections critiques entre plusieurs instances
- **Monitoring** - Surveillance de la santé et des performances du système
- **Hautement Évolutif** - Conception pour une scalabilité horizontale et verticale

## Installation

```bash
npm install redis-threading
```

```bash
yarn add redis-threading
```

```bash
bun install redis-threading
```

```bash
pnpm install redis-threading
```

## Prérequis

- Node.js >= 16.0.0
- Redis Server >= 5.0.0

## Utilisation Rapide

```typescript
import RedisThreading from 'redis-threading';
import * as path from 'path';

async function main() {
  // Créer une instance avec la configuration
  const rt = new RedisThreading({
    redis: {
      host: 'localhost',
      port: 6379,
      password: '',
      db: 0,
    },
    namespace: 'myapp',
  });

  // Initialiser la bibliothèque
  await rt.initialize();

  // Initialiser le worker pool
  await rt.initializeWorkerPool(path.resolve(__dirname, './worker.js'));

  // Enregistrer des handlers de tâches
  rt.registerTaskHandler('math:add', async (data) => {
    return { result: data.a + data.b };
  });

  // Démarrer le consommateur de files d'attente
  rt.startQueueConsumer(2, ['default']);

  // Exécuter une tâche localement
  const result = await rt.executeTask('math:add', { a: 5, b: 3 });
  console.log('Résultat:', result.result);

  // Soumettre une tâche à la file d'attente Redis
  rt.enqueueTask('math:multiply', { a: 4, b: 7 }).then((result) =>
    console.log('Résultat:', result.result)
  );

  // Partager des données
  await rt.setState('counter', 1);

  // S'abonner aux changements
  rt.onStateChange('counter', (newValue) => {
    console.log('Nouveau compteur:', newValue);
  });

  // Fermeture propre
  process.on('SIGINT', async () => {
    await rt.shutdown();
    process.exit(0);
  });
}

main().catch(console.error);
```

## Documentation Complète

Pour une documentation complète incluant tous les concepts avancés, consultez le [Wiki](https://github.com/yourusername/redis-threading/wiki).

## Design Patterns Utilisés

Cette bibliothèque implémente plusieurs design patterns pour une architecture propre et maintenable :

- **Singleton** - Pour les gestionnaires globaux (WorkerPool, QueueManager, etc.)
- **Factory** - Pour la création d'objets complexes (RedisClientFactory)
- **Repository** - Pour l'abstraction des accès aux données (TaskQueue)
- **Observer** - Pour les notifications d'événements (MessageBroker, SharedState)
- **Command** - Pour l'encapsulation des actions (TaskExecutor)
- **Strategy** - Pour les différentes stratégies de distribution des tâches
- **Façade** - Pour une interface simplifiée (RedisThreading)

## Licence

MIT
