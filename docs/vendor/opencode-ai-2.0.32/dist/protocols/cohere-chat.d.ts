import { Schema } from "effect";
import { Route } from "../route/client.js";
import { Protocol } from "../route/protocol.js";
import { Lifecycle } from "./utils/lifecycle.js";
import { ToolStream } from "./utils/tool-stream.js";
export declare const DEFAULT_BASE_URL = "https://api.cohere.com/v2";
declare const Options: Schema.Struct<{
    readonly thinking: Schema.optional<Schema.Struct<{
        readonly type: Schema.optional<Schema.Literals<readonly ["enabled", "disabled"]>>;
        readonly tokenBudget: Schema.optional<Schema.Int>;
    }>>;
}>;
export type ProviderOptionsInput = Schema.Schema.Type<typeof Options>;
export declare const protocol: Protocol<{
    readonly model: string;
    readonly messages: readonly {
        readonly role: "tool" | "system" | "user" | "assistant";
        readonly content?: string | readonly ({
            readonly type: "text";
            readonly text: string;
        } | {
            readonly type: "thinking";
            readonly thinking: string;
        } | {
            readonly type: "image_url";
            readonly image_url: {
                readonly url: string;
            };
        })[] | undefined;
        readonly tool_calls?: readonly {
            readonly id: string;
            readonly type: "function";
            readonly function: {
                readonly name: string;
                readonly arguments: string;
            };
        }[] | undefined;
        readonly tool_call_id?: string | undefined;
        readonly tool_plan?: string | undefined;
    }[];
    readonly stream: true;
    readonly max_tokens?: number | undefined;
    readonly temperature?: number | undefined;
    readonly tools?: readonly {
        readonly type: "function";
        readonly function: {
            readonly name: string;
            readonly parameters: unknown;
            readonly description?: string | undefined;
        };
    }[] | undefined;
    readonly seed?: number | undefined;
    readonly thinking?: {
        readonly type: string;
        readonly token_budget?: number | undefined;
    } | undefined;
    readonly tool_choice?: "NONE" | "REQUIRED" | undefined;
    readonly stop_sequences?: readonly string[] | undefined;
    readonly p?: number | undefined;
    readonly k?: number | undefined;
    readonly frequency_penalty?: number | undefined;
    readonly presence_penalty?: number | undefined;
}, string, {
    readonly type: "message-start";
} | {
    readonly type: "content-start" | "content-delta";
    readonly index: number;
    readonly delta: {
        readonly message: {
            readonly content: {
                readonly text?: string | undefined;
                readonly thinking?: string | undefined;
            };
        };
    };
} | {
    readonly type: "content-end";
    readonly index: number;
} | {
    readonly type: "tool-plan-delta";
    readonly delta: {
        readonly message: {
            readonly tool_plan: string;
        };
    };
} | {
    readonly type: "tool-call-start" | "tool-call-delta";
    readonly index: number;
    readonly delta: {
        readonly message: {
            readonly tool_calls: {
                readonly function: {
                    readonly name?: string | undefined;
                    readonly arguments?: string | undefined;
                };
                readonly id?: string | undefined;
            };
        };
    };
} | {
    readonly type: "tool-call-end";
    readonly index: number;
} | {
    readonly type: "message-end";
    readonly delta: {
        readonly finish_reason: string;
        readonly usage?: {
            readonly tokens?: {
                readonly input_tokens?: number | undefined;
                readonly output_tokens?: number | undefined;
                readonly reasoning_tokens?: number | undefined;
            } | undefined;
            readonly billed_units?: {
                readonly input_tokens?: number | undefined;
                readonly output_tokens?: number | undefined;
                readonly reasoning_tokens?: number | undefined;
            } | undefined;
            readonly cached_tokens?: number | undefined;
        } | undefined;
    };
} | {
    readonly type: "citation-start" | "citation-end";
}, {
    readonly tools: Partial<Record<number, ToolStream.PendingTool>>;
    readonly lifecycle: Lifecycle.State;
    readonly finished: boolean;
}>;
export declare const route: Route<{
    readonly model: string;
    readonly messages: readonly {
        readonly role: "tool" | "system" | "user" | "assistant";
        readonly content?: string | readonly ({
            readonly type: "text";
            readonly text: string;
        } | {
            readonly type: "thinking";
            readonly thinking: string;
        } | {
            readonly type: "image_url";
            readonly image_url: {
                readonly url: string;
            };
        })[] | undefined;
        readonly tool_calls?: readonly {
            readonly id: string;
            readonly type: "function";
            readonly function: {
                readonly name: string;
                readonly arguments: string;
            };
        }[] | undefined;
        readonly tool_call_id?: string | undefined;
        readonly tool_plan?: string | undefined;
    }[];
    readonly stream: true;
    readonly max_tokens?: number | undefined;
    readonly temperature?: number | undefined;
    readonly tools?: readonly {
        readonly type: "function";
        readonly function: {
            readonly name: string;
            readonly parameters: unknown;
            readonly description?: string | undefined;
        };
    }[] | undefined;
    readonly seed?: number | undefined;
    readonly thinking?: {
        readonly type: string;
        readonly token_budget?: number | undefined;
    } | undefined;
    readonly tool_choice?: "NONE" | "REQUIRED" | undefined;
    readonly stop_sequences?: readonly string[] | undefined;
    readonly p?: number | undefined;
    readonly k?: number | undefined;
    readonly frequency_penalty?: number | undefined;
    readonly presence_penalty?: number | undefined;
}, import("../route/transport/http.js").HttpPrepared<string>, import("../route/client.js").CompactionOperations | undefined>;
export * as CohereChat from "./cohere-chat.js";
