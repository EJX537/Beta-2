import type { InterviewSession } from "../types.js";

/**
 * In-memory session store keyed by thread_id.
 *
 * Sessions expire after SESSION_TTL_MS of inactivity.
 * A periodic sweep evicts expired sessions.
 */
export class InterviewSessionStore {
    private readonly sessions = new Map<string, InterviewSession>();
    private readonly sweepInterval: ReturnType<typeof setInterval> | null =
        null;

    private static readonly SWEEP_INTERVAL_MS = 60_000; // 60 seconds
    private static readonly SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

    constructor() {
        this.sweepInterval = setInterval(
            () => this.sweep(),
            InterviewSessionStore.SWEEP_INTERVAL_MS,
        );
        // Allow the process to exit even if this interval is still active
        if (this.sweepInterval && typeof this.sweepInterval === "object") {
            this.sweepInterval.unref();
        }
    }

    /**
     * Get a session by thread_id, or undefined if not found / expired.
     */
    get(threadId: string): InterviewSession | undefined {
        const session = this.sessions.get(threadId);
        if (!session) {
            return undefined;
        }

        // Check expiry
        const age = Date.now() - session.updatedAt;
        if (age > InterviewSessionStore.SESSION_TTL_MS) {
            this.sessions.delete(threadId);
            return undefined;
        }

        return session;
    }

    /**
     * Store or update a session.
     */
    set(threadId: string, session: InterviewSession): void {
        session.updatedAt = Date.now();
        this.sessions.set(threadId, session);
    }

    /**
     * Remove a session.
     */
    delete(threadId: string): void {
        this.sessions.delete(threadId);
    }

    /**
     * Remove expired sessions.
     */
    sweep(): void {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (
                now - session.updatedAt >
                InterviewSessionStore.SESSION_TTL_MS
            ) {
                this.sessions.delete(id);
            }
        }
    }

    /**
     * Dispose the store (clear interval and sessions).
     */
    dispose(): void {
        if (this.sweepInterval) {
            clearInterval(this.sweepInterval);
        }
        this.sessions.clear();
    }
}
