export declare class Serializer {
    /**
     * Sérialise un objet en JSON avec gestion des types spéciaux
     */
    static serialize(obj: any): string;
    /**
     * Désérialise une chaîne JSON avec reconstruction des types spéciaux
     */
    static deserialize<T = any>(json: string): T;
}
