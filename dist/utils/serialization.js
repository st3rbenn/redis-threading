"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Serializer = void 0;
class Serializer {
    /**
     * Sérialise un objet en JSON avec gestion des types spéciaux
     */
    static serialize(obj) {
        return JSON.stringify(obj, (key, value) => {
            // Traitement spécial pour les types non-JSON
            if (value instanceof Error) {
                return {
                    __type: 'Error',
                    name: value.name,
                    message: value.message,
                    stack: value.stack
                };
            }
            if (value instanceof Date) {
                return {
                    __type: 'Date',
                    iso: value.toISOString()
                };
            }
            if (value instanceof Set) {
                return {
                    __type: 'Set',
                    values: Array.from(value)
                };
            }
            if (value instanceof Map) {
                return {
                    __type: 'Map',
                    entries: Array.from(value.entries())
                };
            }
            if (typeof value === 'function') {
                return {
                    __type: 'Function',
                    name: value.name || 'anonymous'
                };
            }
            if (value instanceof RegExp) {
                return {
                    __type: 'RegExp',
                    source: value.source,
                    flags: value.flags
                };
            }
            return value;
        });
    }
    /**
     * Désérialise une chaîne JSON avec reconstruction des types spéciaux
     */
    static deserialize(json) {
        return JSON.parse(json, (key, value) => {
            if (typeof value !== 'object' || value === null || !value.__type) {
                return value;
            }
            switch (value.__type) {
                case 'Error':
                    const error = new Error(value.message);
                    error.name = value.name;
                    error.stack = value.stack;
                    return error;
                case 'Date':
                    return new Date(value.iso);
                case 'Set':
                    return new Set(value.values);
                case 'Map':
                    return new Map(value.entries);
                case 'Function':
                    // On ne peut pas reconstruire une fonction
                    return function () {
                        throw new Error(`Cannot execute deserialized function '${value.name}'`);
                    };
                case 'RegExp':
                    return new RegExp(value.source, value.flags);
                default:
                    return value;
            }
        });
    }
}
exports.Serializer = Serializer;
//# sourceMappingURL=serialization.js.map