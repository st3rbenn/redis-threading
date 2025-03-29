"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageBroker = void 0;
const events_1 = require("events");
const uuid_1 = require("uuid");
const logger_1 = require("../utils/logger");
const redis_client_1 = require("../utils/redis-client");
const serialization_1 = require("../utils/serialization");
/**
 * Broker de messages pour la communication entre processus
 * Implémente le pattern Observer et Pub/Sub
 */
class MessageBroker extends events_1.EventEmitter {
    constructor(redisConfig, namespace = 'rt') {
        super();
        this.redisConfig = redisConfig;
        this.namespace = namespace;
        this.handlers = new Map();
        this.replyHandlers = new Map();
        this.isShuttingDown = false;
        this.logger = new logger_1.Logger('MessageBroker');
        this.nodeId = (0, uuid_1.v4)();
        // Obtenir les clients Redis
        const factory = redis_client_1.RedisClientFactory.getInstance();
        this.publisherClient = factory.getPublisherClient(redisConfig);
        this.subscriberClient = factory.getSubscriberClient(redisConfig);
        // Configurer les événements du subscriber
        this.setupSubscriber();
    }
    /**
     * Obtient l'instance unique du broker
     */
    static getInstance(redisConfig, namespace) {
        if (!MessageBroker.instance) {
            if (!redisConfig) {
                throw new Error('Redis config is required for first initialization');
            }
            MessageBroker.instance = new MessageBroker(redisConfig, namespace);
        }
        return MessageBroker.instance;
    }
    /**
     * Configure le client subscriber
     */
    setupSubscriber() {
        this.subscriberClient.on('message', (channel, message) => {
            if (this.isShuttingDown)
                return;
            try {
                const parsedMessage = serialization_1.Serializer.deserialize(message);
                this.handleIncomingMessage(channel, parsedMessage);
            }
            catch (error) {
                this.logger.error(`Error handling message on channel ${channel}`, error);
            }
        });
        // S'abonner au canal de réponse personnel
        const replyChannel = `${this.namespace}:reply:${this.nodeId}`;
        this.subscriberClient.subscribe(replyChannel, (err) => {
            if (err) {
                this.logger.error(`Error subscribing to reply channel ${replyChannel}`, err);
            }
            else {
                this.logger.debug(`Subscribed to reply channel: ${replyChannel}`);
            }
        });
    }
    /**
     * Gère un message entrant
     */
    handleIncomingMessage(channel, message) {
        // Vérifier si c'est une réponse à une requête
        if (channel.startsWith(`${this.namespace}:reply:`)) {
            this.handleReplyMessage(message);
            return;
        }
        // Obtenir le nom du canal sans le préfixe
        const channelName = channel.startsWith(`${this.namespace}:`)
            ? channel.slice(this.namespace.length + 1)
            : channel;
        // Déclencher l'événement pour le canal
        this.emit(`message:${channelName}`, message.data);
        // Appeler les handlers spécifiques
        const handlers = this.handlers.get(channelName);
        if (handlers) {
            for (const handler of handlers) {
                try {
                    handler(message);
                }
                catch (error) {
                    this.logger.error(`Error in message handler for channel ${channelName}`, error);
                }
            }
        }
    }
    /**
     * Gère un message de réponse
     */
    handleReplyMessage(message) {
        const replyHandler = this.replyHandlers.get(message.id);
        if (!replyHandler)
            return;
        // Nettoyer le timeout
        clearTimeout(replyHandler.timeout);
        this.replyHandlers.delete(message.id);
        // Résoudre ou rejeter la promesse
        if (message.data && message.data.error) {
            replyHandler.reject(message.data.error);
        }
        else {
            replyHandler.resolve(message.data);
        }
    }
    /**
     * S'abonne à un canal
     */
    subscribe(channel, handler) {
        const fullChannel = `${this.namespace}:${channel}`;
        // Ajouter le handler
        if (!this.handlers.has(channel)) {
            this.handlers.set(channel, new Set());
            // S'abonner au canal Redis
            this.subscriberClient.subscribe(fullChannel, (err) => {
                if (err) {
                    this.logger.error(`Error subscribing to channel ${fullChannel}`, err);
                }
                else {
                    this.logger.debug(`Subscribed to channel: ${fullChannel}`);
                }
            });
        }
        this.handlers.get(channel).add(handler);
        // Retourner une fonction pour se désabonner
        return () => {
            const handlers = this.handlers.get(channel);
            if (handlers) {
                handlers.delete(handler);
                // Si plus de handlers, se désabonner du canal
                if (handlers.size === 0) {
                    this.handlers.delete(channel);
                    this.subscriberClient.unsubscribe(fullChannel);
                    this.logger.debug(`Unsubscribed from channel: ${fullChannel}`);
                }
            }
        };
    }
    /**
     * Publie un message sur un canal
     */
    async publish(channel, data) {
        const fullChannel = `${this.namespace}:${channel}`;
        const message = {
            id: (0, uuid_1.v4)(),
            channel,
            data,
            timestamp: Date.now(),
            sender: this.nodeId
        };
        await this.publisherClient.publish(fullChannel, serialization_1.Serializer.serialize(message));
        this.logger.debug(`Published message to channel ${fullChannel}`);
    }
    /**
     * Envoie une requête et attend une réponse
     */
    async request(channel, data, timeout = 30000) {
        const fullChannel = `${this.namespace}:${channel}`;
        const messageId = (0, uuid_1.v4)();
        const message = {
            id: messageId,
            channel,
            data,
            timestamp: Date.now(),
            sender: this.nodeId,
            replyTo: `reply:${this.nodeId}`
        };
        // Créer une promesse qui sera résolue lorsque la réponse arrivera
        return new Promise((resolve, reject) => {
            // Configurer un timeout
            const timeoutId = setTimeout(() => {
                this.replyHandlers.delete(messageId);
                reject(new Error(`Request timed out after ${timeout}ms`));
            }, timeout);
            // Stocker le handler de réponse
            this.replyHandlers.set(messageId, { resolve, reject, timeout: timeoutId });
            // Publier la requête
            this.publisherClient.publish(fullChannel, serialization_1.Serializer.serialize(message)).catch(err => {
                clearTimeout(timeoutId);
                this.replyHandlers.delete(messageId);
                reject(err);
            });
            this.logger.debug(`Published request to channel ${fullChannel} with ID ${messageId}`);
        });
    }
    /**
     * Répond à une requête
     */
    async reply(message, data) {
        if (!message.replyTo) {
            throw new Error('Cannot reply to a message without replyTo field');
        }
        const replyChannel = `${this.namespace}:${message.replyTo}`;
        const replyMessage = {
            id: message.id, // Utiliser le même ID pour associer la réponse à la requête
            channel: message.replyTo,
            data,
            timestamp: Date.now(),
            sender: this.nodeId
        };
        await this.publisherClient.publish(replyChannel, serialization_1.Serializer.serialize(replyMessage));
        this.logger.debug(`Replied to message ${message.id} on channel ${replyChannel}`);
    }
    /**
     * Arrête le broker
     */
    async shutdown() {
        if (this.isShuttingDown)
            return;
        this.isShuttingDown = true;
        this.logger.info('Shutting down message broker...');
        // Annuler tous les timeouts
        for (const [id, { timeout }] of this.replyHandlers.entries()) {
            clearTimeout(timeout);
            this.replyHandlers.delete(id);
        }
        // Se désabonner de tous les canaux
        const channels = Array.from(this.handlers.keys())
            .map(channel => `${this.namespace}:${channel}`);
        channels.push(`${this.namespace}:reply:${this.nodeId}`);
        if (channels.length > 0) {
            await this.subscriberClient.unsubscribe(...channels);
        }
        this.handlers.clear();
        this.logger.info('Message broker shutdown complete');
    }
}
exports.MessageBroker = MessageBroker;
//# sourceMappingURL=message-broker.js.map