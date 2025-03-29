import { EventEmitter } from 'events';
import { SharedState } from '../communication/shared-state';
/**
 * Surveille la santé du système et collecte des métriques de base
 */
export declare class HealthMonitor extends EventEmitter {
    private checkFrequency;
    private logger;
    private checkInterval;
    private lastCpuUsage;
    private metrics;
    private metricsHistorySize;
    private sharedState;
    private nodeId;
    private isShuttingDown;
    constructor(checkFrequency?: number, nodeId?: string);
    /**
     * Connecte le moniteur à l'état partagé pour la synchronisation
     */
    connectToSharedState(sharedState: SharedState): void;
    /**
     * Démarre la surveillance
     */
    start(): void;
    /**
     * Collecte les métriques système et processus
     */
    private collectMetrics;
    /**
     * Obtient l'utilisation CPU du système
     */
    private getCpuUsage;
    /**
     * Calcule le pourcentage d'utilisation CPU
     */
    private calculateCpuPercent;
    /**
     * Calcule le pourcentage d'utilisation CPU du processus
     */
    private calculateProcessCpuPercent;
    /**
     * Obtient le pourcentage d'utilisation mémoire du système
     */
    private getMemoryUsage;
    /**
     * Mesure le délai de la boucle d'événements
     */
    private measureEventLoopDelay;
    /**
     * Met à jour les métriques historiques
     */
    private updateMetrics;
    /**
     * Vérifie si certains seuils sont dépassés
     */
    private checkThresholds;
    /**
     * Obtient les dernières métriques
     */
    getLatestMetrics(): {
        system: {
            cpu: number;
            memory: number;
            loadAvg: number;
        };
        process: {
            cpu: number;
            memory: number;
            eventLoopDelay: number;
            activeHandles: number;
            activeRequests: number;
        };
        timestamp: number;
    };
    /**
     * Obtient l'historique des métriques
     */
    getMetricsHistory(): {
        system: {
            cpu: number[];
            memory: number[];
            loadAvg: number[];
        };
        process: {
            cpu: number[];
            memory: number[];
            eventLoopDelay: number[];
            activeHandles: number[];
            activeRequests: number[];
        };
    };
    /**
     * Arrête la surveillance
     */
    stop(): Promise<void>;
    /**
     * Vérifie si le moniteur est actif
     */
    isActive(): boolean;
}
