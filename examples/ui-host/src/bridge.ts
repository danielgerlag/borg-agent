export interface ExampleCommandBridge {
  invoke(id: string, input: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    borg: {
      command: ExampleCommandBridge;
    };
  }
}
