/**
 * Contracts: Live Features Toggle (spec 2026-10-12-live-features-toggle)
 *
 * Shapes of the modules this spec adds or changes. The implementation is
 * CommonJS JavaScript; these declarations pin names, inputs and outputs for
 * the tests and the review. Type-check:
 *   npx -p typescript@5.4.5 tsc -p specs/2026-10-12-live-features-toggle/contracts/tsconfig.json
 */

// ---------------------------------------------------------------------------
// src/features/listen/liveFeatures.js (NEW, pure)
// ---------------------------------------------------------------------------

export type LiveFeatures = 'both' | 'answer' | 'insights';

export interface LiveFeaturesState {
  /** Normalized. */
  mode: LiveFeatures;
  /** Whether Live Answer runs. */
  answer: boolean;
  /** Whether Live Insights runs. */
  insights: boolean;
}

export interface ViewLabels {
  /** Top-bar text in the insights view (not hovering copy). */
  title: string;
  /** Text of the toggle button while the transcript view is showing. */
  showButton: string;
  /** Top-bar text while hovering the copy button in the insights view. */
  copyHover: string;
}

export interface LiveFeaturesModule {
  LIVE_FEATURES: readonly ['both', 'answer', 'insights'];
  DEFAULT_LIVE_FEATURES: 'both';
  /** The value when it is one of the three, else 'both'. */
  normalizeLiveFeatures(value: unknown): LiveFeatures;
  answerEnabled(mode: unknown): boolean;
  insightsEnabled(mode: unknown): boolean;
  /** both -> answer -> insights -> both. Any other input is treated as 'both'. */
  nextLiveFeatures(mode: unknown): LiveFeatures;
  liveFeaturesState(mode: unknown): LiveFeaturesState;
  /** 'Answer + Insights' | 'Answer only' | 'Insights only'. */
  liveFeaturesLabel(mode: unknown): string;
  viewLabels(mode: unknown): ViewLabels;
}

// ---------------------------------------------------------------------------
// src/features/listen/summary/summaryService.js (EDIT, additions only)
// ---------------------------------------------------------------------------

export interface SummaryServiceLiveFeatures {
  /** 'both' after construction. */
  liveFeatures: LiveFeatures;
  /**
   * Stores normalizeLiveFeatures(mode) and logs `[Live] features=<mode>`.
   * When Answer goes from on to off it calls pauseLiveAnswer().
   */
  setLiveFeatures(mode: unknown): void;
  /**
   * Clears the debounce timer, aborts the in-flight stream, sets inFlight=false.
   * Keeps lastAnsweredTail, careerPrev and activeCompany.
   */
  pauseLiveAnswer(): void;
  /** Returns first when Answer is off (before company detection, trace, prefetch, timer). */
  triggerAnswerIfNeeded(speaker: string, text: string): void;
  /** Returns first when Insights is off (before the turn-count test). */
  triggerAnalysisIfNeeded(): Promise<void>;
}

// ---------------------------------------------------------------------------
// src/features/listen/listenService.js (EDIT)
// ---------------------------------------------------------------------------

export interface ListenServiceLiveFeatures {
  /** Passes the mode to the summary service. */
  setLiveFeatures(mode: unknown): void;
}

// ---------------------------------------------------------------------------
// IPC (featureBridge.js, preload.js)
// ---------------------------------------------------------------------------

export type SetLiveFeaturesResult =
  | ({ success: true } & LiveFeaturesState)
  | { success: false; error: string };

export interface SettingsViewLiveFeaturesApi {
  /** settings:getLiveFeatures */
  getLiveFeatures(): Promise<LiveFeaturesState>;
  /** settings:setLiveFeatures */
  setLiveFeatures(mode: LiveFeatures): Promise<SetLiveFeaturesResult>;
}

export interface ListenViewLiveFeaturesApi {
  /** settings:getLiveFeatures */
  getLiveFeatures(): Promise<LiveFeaturesState>;
  /** listen:liveFeaturesChanged */
  onLiveFeaturesChanged(callback: (event: unknown, state: LiveFeaturesState) => void): void;
  removeOnLiveFeaturesChanged(callback: (event: unknown, state: LiveFeaturesState) => void): void;
}

// ---------------------------------------------------------------------------
// Renderer (EDIT)
// ---------------------------------------------------------------------------

export interface LiveAnswerEntry {
  id?: string | number;
  question?: string;
  text?: string;
}

export interface LiveAnswerHistoryAdditions {
  /** Newest-first entries to text: "<question>\n<text>" joined by a blank line; '' for none. */
  answersToText(answers: readonly LiveAnswerEntry[] | null | undefined): string;
}

export interface LiveAnswerViewAdditions {
  /** Render "Waiting for a question..." when visible with no answers and no status. Default false. */
  showEmptyState: boolean;
  /** answersToText(this.answers). */
  getAnswerText(): string;
}
