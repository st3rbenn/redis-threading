"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisClientFactory = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const events_1 = require("events");
const logger_1 = require("./logger");
/**
 * Factory et gestionnaire de clients Redis
 * Utilise le pattern Singleton pour éviter de créer trop de connexions
 */
class RedisClientFactory {
    constructor() {
        this.clients = new Map();
        this.events = new events_1.EventEmitter();
        this.logger = new logger_1.Logger('RedisClientFactory');
    }
    /**
     * Obtenir l'instance unique de la factory
     */
    static getInstance() {
        if (!RedisClientFactory.instance) {
            RedisClientFactory.instance = new RedisClientFactory();
        }
        return RedisClientFactory.instance;
    }
    /**
     * Crée ou récupère un client Redis
     * @param config Configuration Redis
     * @param clientName Nom du client (pour réutilisation)
     */
    getClient(config, clientName = 'default') {
        const cacheKey = `${clientName}:${config.host}:${config.port}:${config.db || 0}`;
        if (this.clients.has(cacheKey)) {
            return this.clients.get(cacheKey);
        }
        this.logger.info(`Creating new Redis client: ${cacheKey}`);
        const client = new ioredis_1.default({
            host: config.host,
            port: config.port,
            password: config.password,
            db: config.db || 0,
            keyPrefix: config.keyPrefix,
            // Options de reconnexion automatique
            retryStrategy: (times) => {
                const delay = Math.min(times * 100, 3000);
                this.logger.warn(`Redis connection attempt ${times} failed. Retrying in ${delay}ms...`);
                return delay;
            },
            // Limiter le nombre maximum de tentatives de reconnexion
            maxRetriesPerRequest: 5
        });
        // Gestion des événements
        client.on('connect', () => {
            this.logger.info(`Redis client connected: ${cacheKey}`);
            this.events.emit('connect', { client: cacheKey });
        });
        client.on('error', (err) => {
            this.logger.error(`Redis client error: ${cacheKey}`, err);
            this.events.emit('error', { client: cacheKey, error: err });
        });
        client.on('reconnecting', (time) => {
            this.logger.warn(`Redis client reconnecting after ${time}ms: ${cacheKey}`);
            this.events.emit('reconnecting', { client: cacheKey, time });
        });
        client.on('close', () => {
            this.logger.warn(`Redis client connection closed: ${cacheKey}`);
            this.events.emit('close', { client: cacheKey });
        });
        this.clients.set(cacheKey, client);
        return client;
    }
    /**
     * Obtient un client dédié à la publication
     */
    getPublisherClient(config) {
        return this.getClient(config, 'publisher');
    }
    /**
     * Obtient un client dédié à l'abonnement
     */
    getSubscriberClient(config) {
        return this.getClient(config, 'subscriber');
    }
    /**
     * Ferme tous les clients Redis
     */
    async closeAll() {
        const closePromises = [];
        for (const [key, client] of this.clients.entries()) {
            closePromises.push(new Promise((resolve) => {
                client.quit().then(() => {
                    this.logger.info(`Redis client closed: ${key}`);
                    resolve(key);
                });
            }));
        }
        await Promise.all(closePromises);
        this.clients.clear();
    }
    /**
     * S'abonne aux événements Redis
     */
    on(event, listener) {
        this.events.on(event, listener);
    }
}
exports.RedisClientFactory = RedisClientFactory;
//# sourceMappingURL=redis-client.js.map