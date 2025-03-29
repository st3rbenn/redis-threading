import { EventEmitter } from 'events';
import { RedisConfig } from '../types/config';
/**
 * Gestionnaire d'état partagé basé sur Redis
 * Permet de partager des données entre processus de manière synchronisée
 */
export declare class SharedState extends EventEmitter {
    private redisConfig;
    private namespace;
    private static instance;
    private client;
    private subscriberClient;
    private logger;
    private locks;
    private isShuttingDown;
    private constructor();
    /**
     * Obtient l'instance unique du gestionnaire d'état
     */
    static getInstance(redisConfig?: RedisConfig, namespace?: string): SharedState;
    /**
     * Configure le subscriber pour les notifications de changement
     */
    private setupSubscriber;
    /**
     * Publie une notification de changement
     */
    private notifyChange;
    /**
     * Obtient la clé Redis complète pour une clé donnée
     */
    private getFullKey;
    /**
     * Stocke une valeur dans l'état partagé
     */
    set<T = any>(key: string, value: T, options?: {
        ttl?: number;
        ifNotExists?: boolean;
    }): Promise<boolean>;
    /**
     * Récupère une valeur de l'état partagé
     */
    get<T = any>(key: string): Promise<T | null>;
    /**
     * Supprime une clé de l'état partagé
     */
    delete(key: string): Promise<boolean>;
    /**
     * Définit une durée d'expiration pour une clé
     */
    expire(key: string, seconds: number): Promise<boolean>;
    /**
     * Vérifie si une clé existe
     */
    exists(key: string): Promise<boolean>;
    /**
     * Incrémente un compteur
     */
    increment(key: string, increment?: number): Promise<number>;
    /**
     * Décrémente un compteur
     */
    decrement(key: string, decrement?: number): Promise<number>;
    /**
     * Acquiert un verrou distribué
     */
    acquireLock(lockName: string, ttl?: number): Promise<boolean>;
    /**
     * Relâche un verrou distribué
     */
    releaseLock(lockName: string): Promise<boolean>;
    /**
     * Obtient toutes les clés correspondant à un pattern
     */
    getKeys(pattern: string): Promise<string[]>;
    /**
     * Récupère plusieurs valeurs en une seule opération
     */
    getMulti<T = any>(keys: string[]): Promise<Map<string, T | null>>;
    /**
     * Stocke plusieurs valeurs en une seule opération
     */
    setMulti<T = any>(data: Map<string, T>): Promise<void>;
    /**
     * S'abonne aux changements d'une clé
     */
    onChange(key: string, callback: (data: {
        type: 'set' | 'delete' | 'expire';
        timestamp: number;
    }) => void): () => void;
    /**
     * S'abonne à tous les changements
     */
    onAnyChange(callback: (data: {
        key: string;
        type: 'set' | 'delete' | 'expire';
        timestamp: number;
    }) => void): () => void;
    /**
     * Arrête le gestionnaire d'état
     */
    shutdown(): Promise<void>;
}
