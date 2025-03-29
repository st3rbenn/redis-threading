import { RedisConfig } from '../types/config';
/**
 * Collecte et agrège les métriques de plusieurs nœuds
 */
export declare class MetricsCollector {
    private namespace;
    private checkFrequency;
    private logger;
    private sharedState;
    private watchInterval;
    private metricNodes;
    private nodeTimeout;
    private latestMetrics;
    private isShuttingDown;
    constructor(redisConfig: RedisConfig, namespace?: string, checkFrequency?: number);
    /**
     * Démarre la collecte de métriques
     */
    start(): void;
    /**
     * Découvre les nœuds actifs en recherchant les clés de métriques
     */
    private discoverNodes;
    /**
     * Met à jour les métriques d'un nœud spécifique
     */
    private updateNodeMetrics;
    /**
     * Obtient les métriques agrégées de tous les nœuds
     */
    getAggregatedMetrics(): {
        nodes: string[];
        system: {
            avgCpu: number;
            avgMemory: number;
            avgLoadAvg: number;
            totalNodes: number;
        };
        byNode: Map<string, any>;
    };
    /**
     * Obtient les métriques d'un nœud spécifique
     */
    getNodeMetrics(nodeId: string): any;
    /**
     * Arrête la collecte de métriques
     */
    stop(): Promise<void>;
}
