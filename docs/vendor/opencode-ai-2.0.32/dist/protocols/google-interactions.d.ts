import { Schema } from "effect";
import { Route } from "../route/client.js";
import { Protocol } from "../route/protocol.js";
import { Lifecycle } from "./utils/lifecycle.js";
import { ToolStream } from "./utils/tool-stream.js";
export declare const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
declare const Options: Schema.Struct<{
    readonly previousInteractionId: Schema.optionalKey<Schema.middlewareDecoding<Schema.UndefinedOr<Schema.String>, never>>;
    readonly store: Schema.optionalKey<Schema.middlewareDecoding<Schema.UndefinedOr<Schema.Boolean>, never>>;
    readonly thinkingLevel: Schema.optionalKey<Schema.middlewareDecoding<Schema.UndefinedOr<Schema.declare<import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high">, import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high">>>, never>>;
    readonly thinkingSummaries: Schema.optionalKey<Schema.middlewareDecoding<Schema.UndefinedOr<Schema.declare<import("../schema/options.js").OpenString<"auto" | "none">, import("../schema/options.js").OpenString<"auto" | "none">>>, never>>;
    readonly serviceTier: Schema.optionalKey<Schema.middlewareDecoding<Schema.UndefinedOr<Schema.declare<import("../schema/options.js").OpenString<"standard" | "flex" | "priority" | "deferred">, import("../schema/options.js").OpenString<"standard" | "flex" | "priority" | "deferred">>>, never>>;
}>;
export type OptionsInput = typeof Options.Encoded;
export type ProviderOptionsInput = OptionsInput;
declare const OutputStep: Schema.Struct<{
    readonly type: Schema.String;
    readonly id: Schema.optional<Schema.String>;
    readonly name: Schema.optional<Schema.String>;
    readonly arguments: Schema.optional<Schema.$Record<Schema.String, Schema.Unknown>>;
    readonly signature: Schema.optional<Schema.String>;
    readonly summary: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly type: Schema.Literal<"text">;
        readonly text: Schema.String;
    }>>>;
    readonly content: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly type: Schema.String;
        readonly text: Schema.optional<Schema.String>;
    }>>>;
}>;
type OutputStep = typeof OutputStep.Type;
interface ParserState {
    readonly route: string;
    readonly metadataKey: string;
    readonly lifecycle: Lifecycle.State;
    readonly steps: Partial<Record<number, OutputStep>>;
    readonly tools: ToolStream.State<number>;
    readonly completed: boolean;
}
export declare const protocol: Protocol<{
    readonly input: readonly ({
        readonly type: "user_input" | "model_output";
        readonly content: readonly ({
            readonly type: "text";
            readonly text: string;
        } | {
            readonly type: "image" | "document" | "video" | "audio";
            readonly mime_type: string;
            readonly data?: string | undefined;
            readonly uri?: string | undefined;
        })[];
    } | {
        readonly type: "thought";
        readonly summary?: readonly {
            readonly type: "text";
            readonly text: string;
        }[] | undefined;
        readonly signature?: string | undefined;
    } | {
        readonly id: string;
        readonly type: "function_call";
        readonly name: string;
        readonly arguments: unknown;
        readonly signature?: string | undefined;
    } | {
        readonly type: "function_result";
        readonly name: string;
        readonly result: unknown;
        readonly call_id: string;
        readonly is_error?: boolean | undefined;
    })[];
    readonly model: string;
    readonly stream: true;
    readonly store: boolean;
    readonly generation_config: {
        readonly temperature?: number | undefined;
        readonly seed?: number | undefined;
        readonly tool_choice?: "auto" | "none" | "any" | {
            readonly allowed_tools: {
                readonly mode: "any";
                readonly tools: readonly string[];
            };
        } | undefined;
        readonly top_p?: number | undefined;
        readonly stop_sequences?: readonly string[] | undefined;
        readonly max_output_tokens?: number | undefined;
        readonly thinking_level?: import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high"> | undefined;
        readonly thinking_summaries?: string | undefined;
    };
    readonly tools?: readonly {
        readonly type: "function";
        readonly name: string;
        readonly description: string;
        readonly parameters: {
            readonly [x: string]: unknown;
        };
    }[] | undefined;
    readonly service_tier?: string | undefined;
    readonly previous_interaction_id?: string | undefined;
    readonly system_instruction?: string | undefined;
}, string, {
    readonly event_type: "step.start";
    readonly index: number;
    readonly step: {
        readonly type: string;
        readonly id?: string | undefined;
        readonly name?: string | undefined;
        readonly summary?: readonly {
            readonly type: "text";
            readonly text: string;
        }[] | undefined;
        readonly content?: readonly {
            readonly type: string;
            readonly text?: string | undefined;
        }[] | undefined;
        readonly signature?: string | undefined;
        readonly arguments?: {
            readonly [x: string]: unknown;
        } | undefined;
    };
} | {
    readonly event_type: "step.delta";
    readonly index: number;
    readonly delta: {
        readonly type: "text";
        readonly text: string;
    } | {
        readonly type: "arguments_delta";
        readonly arguments: string;
    } | {
        readonly type: "thought_signature";
        readonly signature: string;
    } | {
        readonly type: "thought_summary";
        readonly content: {
            readonly type: "text";
            readonly text: string;
        };
    } | {
        readonly type: string;
    };
} | {
    readonly event_type: "step.stop";
    readonly index: number;
} | {
    readonly event_type: "interaction.created";
    readonly interaction: {
        readonly id?: string | undefined;
    };
} | {
    readonly status: string;
    readonly event_type: "interaction.status_update";
    readonly interaction_id?: string | undefined;
} | {
    readonly event_type: "interaction.completed";
    readonly interaction: {
        readonly [x: string]: unknown;
        readonly status: string;
        readonly id?: string | undefined;
        readonly usage?: {
            readonly [x: string]: unknown;
            readonly total_input_tokens?: number | null | undefined;
            readonly total_cached_tokens?: number | null | undefined;
            readonly total_output_tokens?: number | null | undefined;
            readonly total_thought_tokens?: number | null | undefined;
            readonly total_tokens?: number | null | undefined;
            readonly raw_prompt_token?: number | null | undefined;
        } | undefined;
    };
} | {
    readonly event_type: "error";
    readonly error: unknown;
}, ParserState>;
export declare const route: Route<{
    readonly input: readonly ({
        readonly type: "user_input" | "model_output";
        readonly content: readonly ({
            readonly type: "text";
            readonly text: string;
        } | {
            readonly type: "image" | "document" | "video" | "audio";
            readonly mime_type: string;
            readonly data?: string | undefined;
            readonly uri?: string | undefined;
        })[];
    } | {
        readonly type: "thought";
        readonly summary?: readonly {
            readonly type: "text";
            readonly text: string;
        }[] | undefined;
        readonly signature?: string | undefined;
    } | {
        readonly id: string;
        readonly type: "function_call";
        readonly name: string;
        readonly arguments: unknown;
        readonly signature?: string | undefined;
    } | {
        readonly type: "function_result";
        readonly name: string;
        readonly result: unknown;
        readonly call_id: string;
        readonly is_error?: boolean | undefined;
    })[];
    readonly model: string;
    readonly stream: true;
    readonly store: boolean;
    readonly generation_config: {
        readonly temperature?: number | undefined;
        readonly seed?: number | undefined;
        readonly tool_choice?: "auto" | "none" | "any" | {
            readonly allowed_tools: {
                readonly mode: "any";
                readonly tools: readonly string[];
            };
        } | undefined;
        readonly top_p?: number | undefined;
        readonly stop_sequences?: readonly string[] | undefined;
        readonly max_output_tokens?: number | undefined;
        readonly thinking_level?: import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high"> | undefined;
        readonly thinking_summaries?: string | undefined;
    };
    readonly tools?: readonly {
        readonly type: "function";
        readonly name: string;
        readonly description: string;
        readonly parameters: {
            readonly [x: string]: unknown;
        };
    }[] | undefined;
    readonly service_tier?: string | undefined;
    readonly previous_interaction_id?: string | undefined;
    readonly system_instruction?: string | undefined;
}, import("../route/transport/http.js").HttpPrepared<string>, import("../route/client.js").CompactionOperations | undefined>;
export * as GoogleInteractions from "./google-interactions.js";
