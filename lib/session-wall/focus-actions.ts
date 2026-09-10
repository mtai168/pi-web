export interface GlobalSessionActions {
  sessionId: string;
  abort: () => void | PromiseLike<void>;
}

export interface SessionActionRegistration {
  readonly sessionId: string;
  readonly generation: number;
}

export interface FocusedSessionAction {
  readonly sessionId: string;
  readonly generation: number;
  abort: () => void | PromiseLike<void>;
}

interface RegisteredSessionAction {
  registration: SessionActionRegistration;
  abort: () => void | PromiseLike<void>;
}

const registrations = new Map<number, RegisteredSessionAction>();
let focusedRegistration: SessionActionRegistration | null = null;
let nextGeneration = 0;
let routingEnabled = false;

function getCurrentRegistration(registration: SessionActionRegistration): RegisteredSessionAction | null {
  const current = registrations.get(registration.generation);
  return current?.registration === registration ? current : null;
}

export function registerSessionAction(actions: GlobalSessionActions): SessionActionRegistration {
  const registration = Object.freeze({
    sessionId: actions.sessionId,
    generation: ++nextGeneration,
  });
  registrations.set(registration.generation, { registration, abort: actions.abort });
  routingEnabled = true;
  return registration;
}

export function focusSessionAction(registration: SessionActionRegistration): boolean {
  if (!getCurrentRegistration(registration)) return false;
  focusedRegistration = registration;
  return true;
}

export function clearSessionAction(registration: SessionActionRegistration): boolean {
  if (!getCurrentRegistration(registration)) return false;
  registrations.delete(registration.generation);
  if (focusedRegistration === registration) focusedRegistration = null;
  routingEnabled = registrations.size > 0;
  return true;
}

export function getFocusedSessionAction(): FocusedSessionAction | null {
  if (!focusedRegistration) return null;
  const current = getCurrentRegistration(focusedRegistration);
  if (!current) {
    focusedRegistration = null;
    return null;
  }
  return {
    sessionId: current.registration.sessionId,
    generation: current.registration.generation,
    abort: current.abort,
  };
}

export function invokeFocusedSessionAction(): boolean {
  const action = getFocusedSessionAction();
  if (!action) return false;
  try {
    void Promise.resolve(action.abort()).catch((error: unknown) => {
      console.error("Focused session action failed:", error);
    });
  } catch (error) {
    console.error("Focused session action failed:", error);
  }
  return true;
}

export function isSessionActionRoutingEnabled(): boolean {
  return routingEnabled;
}

export function resetSessionActions(): void {
  registrations.clear();
  focusedRegistration = null;
  routingEnabled = false;
}
