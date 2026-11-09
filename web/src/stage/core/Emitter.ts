export class Emitter<Events extends object> {
  private handlers: { [K in keyof Events]?: Set<(payload: Events[K]) => void> } = {};

  on<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): () => void {
    (this.handlers[type] ??= new Set()).add(fn);
    return () => this.handlers[type]?.delete(fn);
  }

  protected emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.handlers[type]?.forEach((fn) => fn(payload));
  }
}
