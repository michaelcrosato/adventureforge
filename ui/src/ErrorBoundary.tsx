/**
 * Last-resort recovery surface for the double-click audience.
 *
 * The stated player has no terminal and no devtools, and the production build
 * is one self-contained file opened from `PLAY.bat`. Without a boundary, any
 * throw inside the React tree unmounts the whole app and leaves a black page
 * with no text — and because the journey that triggered it is still in
 * `localStorage`, every reload reproduces it, so the player has no way back at
 * all. `App`'s own fail-closed screen covers a save that fails to parse or
 * verify; it cannot cover a throw raised while a screen is being drawn.
 *
 * This module is deliberately dependency-free (React only). It must be able to
 * render when the rest of the UI cannot, so it reads no engine projection, no
 * content, and no save.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

const CRASH_KICKER = "The game could not draw this screen";
const CRASH_TITLE = "Something went wrong";
const CRASH_EXPLANATION =
  "Your saved journey has not been changed. Reloading replays the same saved journey, so if this keeps happening, discarding the save is the way back into the game.";

/** A player-readable single line for an unknown thrown value. */
export function crashDetail(error: unknown): string {
  const trimmed = (error instanceof Error ? error.message : String(error)).trim();
  return trimmed.length > 0 ? trimmed : "The game stopped without reporting a reason.";
}

type AppCrashScreenProps = {
  detail: string;
  onReload: () => void;
  onDiscardSave: () => void;
};

/**
 * Presentational only, so it can be rendered and asserted without a DOM. It
 * reuses the save-recovery styling rather than inventing a second look for the
 * same "the game stopped, here is your way out" moment.
 */
function AppCrashScreen({ detail, onReload, onDiscardSave }: AppCrashScreenProps) {
  return (
    <main className="save-recovery-page">
      <section className="save-recovery-card" aria-labelledby="app-crash-title">
        <p className="nw-kicker">{CRASH_KICKER}</p>
        <h1 id="app-crash-title">{CRASH_TITLE}</h1>
        <p>{detail}</p>
        <p>{CRASH_EXPLANATION}</p>
        <button type="button" onClick={onReload}>
          Reload the game
        </button>
        <button type="button" onClick={onDiscardSave}>
          Discard this save and begin a new journey
        </button>
      </section>
    </main>
  );
}

type AppErrorBoundaryProps = {
  children: ReactNode;
  onReload: () => void;
  onDiscardSave: () => void;
};

type AppErrorBoundaryState = { detail: string | null };

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { detail: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { detail: crashDetail(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The player cannot open a console, but an agent or operator debugging a
    // PLAY.bat report can — keep the component stack somewhere retrievable.
    console.error("AdventureForge failed to render.", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.detail === null) return this.props.children;
    return (
      <AppCrashScreen
        detail={this.state.detail}
        onReload={this.props.onReload}
        onDiscardSave={this.props.onDiscardSave}
      />
    );
  }
}
