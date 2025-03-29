export type Message<T = any> = {
  id: string;
  channel: string;
  data: T;
  timestamp: number;
  sender?: string;
  replyTo?: string; // Canal pour les réponses si c'est une demande
}

export type MessageHandler<T = any> = (
  message: Message<T>
) => Promise<void> | void;
