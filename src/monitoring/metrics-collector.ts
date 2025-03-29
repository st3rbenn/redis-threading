import { RedisConfig } from '../types/config';
import { Logger } from '../utils/logger';
import { SharedState } from '../communication/shared-state';

/**
 * Collecte et agrège les métriques de plusieurs nœuds
 */
export class MetricsCollector {
  private logger: Logger;
  private sharedState: SharedState;
  private watchInterval: NodeJS.Timeout | null = null;
  private metricNodes: Set<string> = new Set();
  private nodeTimeout: Map<string, NodeJS.Timeout> = new Map();
  private latestMetrics: Map<string, any> = new Map();
  private isShuttingDown: boolean = false;

  constructor(
    redisConfig: RedisConfig,
    private namespace: string = 'rt',
    private checkFrequency: number = 15000
  ) {
    this.logger = new Logger('MetricsCollector');
    this.sharedState = SharedState.getInstance(redisConfig, namespace);
  }

  /**
   * Démarre la collecte de métriques
   */
  public start(): void {
    if (this.watchInterval) {
      this.logger.warn('Metrics collector is already running');
      return;
    }

    this.logger.info(`Starting metrics collection with ${this.checkFrequency}ms interval`);

    // S'abonner aux changements de métriques
    this.sharedState.onAnyChange(change => {
      if (change.key.startsWith('metrics:') && change.key.endsWith(':latest')) {
        const nodeId = change.key.split(':')[1];
        this.updateNodeMetrics(nodeId);
      }
    });

    // Vérifier périodiquement les nœuds actifs
    this.watchInterval = setInterval(async () => {
      await this.discoverNodes();
    }, this.checkFrequency);

    // Découvrir les nœuds immédiatement
    this.discoverNodes().catch(err => {
      this.logger.error('Error discovering nodes', err);
    });
  }

  /**
   * Découvre les nœuds actifs en recherchant les clés de métriques
   */
  private async discoverNodes(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      const nodeKeys = await this.sharedState.getKeys('metrics:*:latest');

      // Extraire les IDs de nœud des clés
      for (const key of nodeKeys) {
        const parts = key.split(':');
        if (parts.length === 3 && parts[0] === 'metrics' && parts[2] === 'latest') {
          const nodeId = parts[1];

          if (!this.metricNodes.has(nodeId)) {
            this.logger.info(`Discovered new node: ${nodeId}`);
            this.metricNodes.add(nodeId);
          }

          // Mettre à jour les métriques pour ce nœud
          await this.updateNodeMetrics(nodeId);
        }
      }
    } catch (error) {
      this.logger.error('Error discovering nodes', error);
    }
  }

  /**
   * Met à jour les métriques d'un nœud spécifique
   */
  private async updateNodeMetrics(nodeId: string): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      const metrics = await this.sharedState.get(`metrics:${nodeId}:latest`);

      if (!metrics) {
        // Si le nœud n'existe plus, le supprimer après un délai
        if (this.metricNodes.has(nodeId)) {
          if (!this.nodeTimeout.has(nodeId)) {
            this.nodeTimeout.set(
              nodeId,
              setTimeout(() => {
                this.metricNodes.delete(nodeId);
                this.latestMetrics.delete(nodeId);
                this.nodeTimeout.delete(nodeId);
                this.logger.info(`Node ${nodeId} removed from metrics collection`);
              }, 60000) // Attendre 1 minute avant de supprimer
            );
          }
        }
        return;
      }

      // Nœud actif, annuler le timeout si présent
      if (this.nodeTimeout.has(nodeId)) {
        clearTimeout(this.nodeTimeout.get(nodeId)!);
        this.nodeTimeout.delete(nodeId);
      }

      // Si c'est un nouveau nœud, l'ajouter
      if (!this.metricNodes.has(nodeId)) {
        this.metricNodes.add(nodeId);
        this.logger.info(`Added node ${nodeId} to metrics collection`);
      }

      // Mettre à jour les métriques
      this.latestMetrics.set(nodeId, metrics);
    } catch (error) {
      this.logger.error(`Error updating metrics for node ${nodeId}`, error);
    }
  }

  /**
   * Obtient les métriques agrégées de tous les nœuds
   */
  public getAggregatedMetrics(): {
    nodes: string[];
    system: {
      avgCpu: number;
      avgMemory: number;
      avgLoadAvg: number;
      totalNodes: number;
    };
    byNode: Map<string, any>;
  } {
    // Calculer les moyennes
    let totalCpu = 0;
    let totalMemory = 0;
    let totalLoadAvg = 0;
    let nodeCount = 0;

    for (const metrics of this.latestMetrics.values()) {
      totalCpu += metrics.system.cpu;
      totalMemory += metrics.system.memory;
      totalLoadAvg += metrics.system.loadAvg;
      nodeCount++;
    }

    const avgCpu = nodeCount > 0 ? totalCpu / nodeCount : 0;
    const avgMemory = nodeCount > 0 ? totalMemory / nodeCount : 0;
    const avgLoadAvg = nodeCount > 0 ? totalLoadAvg / nodeCount : 0;

    return {
      nodes: Array.from(this.metricNodes),
      system: {
        avgCpu,
        avgMemory,
        avgLoadAvg,
        totalNodes: nodeCount
      },
      byNode: new Map(this.latestMetrics)
    };
  }

  /**
   * Obtient les métriques d'un nœud spécifique
   */
  public getNodeMetrics(nodeId: string): any {
    return this.latestMetrics.get(nodeId) || null;
  }

  /**
   * Arrête la collecte de métriques
   */
  public async stop(): Promise<void> {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;
    this.logger.info('Stopping metrics collector...');

    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }

    // Nettoyer les timeouts
    for (const [nodeId, timeout] of this.nodeTimeout.entries()) {
      clearTimeout(timeout);
      this.nodeTimeout.delete(nodeId);
    }

    this.logger.info('Metrics collector stopped');
  }
}
