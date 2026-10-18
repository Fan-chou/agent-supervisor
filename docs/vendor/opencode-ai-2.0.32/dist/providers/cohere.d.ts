import { CohereChat } from "../protocols/cohere-chat.js";
import { Route, type RouteDefaultsInput } from "../route/client.js";
import { type ProviderAuthOption } from "../route/auth-options.js";
import { type ModelID, type OpenString } from "../schema/index.js";
import type { ProviderPackage } from "../provider-package.js";
export declare const id: string & import("effect/Brand").Brand<"AI.ProviderID">;
export type ChatOptionsInput = {
    readonly reasoningEffort?: OpenString<"none" | "high">;
};
export type ProviderOptions = CohereChat.ProviderOptionsInput & ChatOptionsInput;
export type LanguageModelOptions = Omit<RouteDefaultsInput, "providerOptions"> & ProviderAuthOption<"optional"> & {
    readonly baseURL?: string;
    readonly providerOptions?: ProviderOptions;
};
export type Settings<Options = CohereChat.ProviderOptionsInput> = ProviderPackage.Settings & Options & {
    readonly apiKey?: string;
    readonly baseURL?: string;
};
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
export declare const chatRoute: Route<{
    readonly model: string;
    readonly messages: readonly ({
        readonly role: "system";
        readonly content: string | readonly ({
            readonly type: "text";
            readonly text: string;
            readonly cache_control?: {
                readonly type: "ephemeral";
                readonly ttl?: string | undefined;
            } | undefined;
        } | {
            readonly type: "image_url";
            readonly image_url: {
                readonly url: string;
            };
        } | {
            readonly type: "file";
            readonly file: {
                readonly filename: string;
                readonly file_data: string;
            };
        })[];
    } | {
        readonly role: "user";
        readonly content: string | readonly ({
            readonly type: "text";
            readonly text: string;
            readonly cache_control?: {
                readonly type: "ephemeral";
                readonly ttl?: string | undefined;
            } | undefined;
        } | {
            readonly type: "image_url";
            readonly image_url: {
                readonly url: string;
            };
        } | {
            readonly type: "file";
            readonly file: {
                readonly filename: string;
                readonly file_data: string;
            };
        })[];
    } | {
        readonly [x: string]: unknown;
        readonly content: string | readonly {
            readonly type: "text";
            readonly text: string;
            readonly cache_control?: {
                readonly type: "ephemeral";
                readonly ttl?: string | undefined;
            } | undefined;
        }[] | null;
        readonly role: "assistant";
        readonly reasoning?: string | undefined;
        readonly reasoning_content?: string | undefined;
        readonly reasoning_text?: string | undefined;
        readonly tool_calls?: readonly {
            readonly function: {
                readonly name: string;
                readonly arguments: string;
            };
            readonly id: string;
            readonly type: "function";
            readonly extra_content?: {
                readonly google: {
                    readonly thought_signature: string;
                };
            } | undefined;
        }[] | undefined;
        readonly reasoning_details?: unknown;
    } | {
        readonly role: "tool";
        readonly tool_call_id: string;
        readonly content: string | readonly {
            readonly type: "text";
            readonly text: string;
            readonly cache_control?: {
                readonly type: "ephemeral";
                readonly ttl?: string | undefined;
            } | undefined;
        }[];
    })[];
    readonly stream: true;
    readonly max_completion_tokens?: number | undefined;
    readonly max_tokens?: number | undefined;
    readonly temperature?: number | undefined;
    readonly tools?: readonly {
        readonly function: {
            readonly description: string;
            readonly name: string;
            readonly parameters: {
                readonly [x: string]: unknown;
            };
            readonly strict?: boolean | undefined;
        };
        readonly type: "function";
        readonly cache_control?: {
            readonly type: "ephemeral";
            readonly ttl?: string | undefined;
        } | undefined;
    }[] | undefined;
    readonly stop?: readonly string[] | undefined;
    readonly seed?: number | undefined;
    readonly tool_choice?: "required" | "auto" | "none" | {
        readonly type: "function";
        readonly function: {
            readonly name: string;
        };
    } | undefined;
    readonly top_p?: number | undefined;
    readonly frequency_penalty?: number | undefined;
    readonly presence_penalty?: number | undefined;
    readonly store?: boolean | undefined;
    readonly prompt_cache_key?: string | undefined;
    readonly reasoning_effort?: import("../schema/options.js").ReasoningEffort | undefined;
    readonly stream_options?: {
        readonly include_usage: boolean;
    } | undefined;
    readonly tool_stream?: boolean | undefined;
}, import("../route/transport/http.js").HttpPrepared<string>, import("../route/client.js").CompactionOperations | undefined>;
export declare const routes: (Route<{
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
}, import("../route/transport/http.js").HttpPrepared<string>, import("../route/client.js").CompactionOperations | undefined> | Route<{
    readonly model: string;
    readonly messages: readonly ({
        readonly role: "system";
        readonly content: string | readonly ({
            readonly type: "text";
            readonly text: string;
            readonly cache_control?: {
                readonly type: "ephemeral";
                readonly ttl?: string | undefined;
            } | undefined;
        } | {
            readonly type: "image_url";
            readonly image_url: {
                readonly url: string;
            };
        } | {
            readonly type: "file";
            readonly file: {
                readonly filename: string;
                readonly file_data: string;
            };
        })[];
    } | {
        readonly role: "user";
        readonly content: string | readonly ({
            readonly type: "text";
            readonly text: string;
            readonly cache_control?: {
                readonly type: "ephemeral";
                readonly ttl?: string | undefined;
            } | undefined;
        } | {
            readonly type: "image_url";
            readonly image_url: {
                readonly url: string;
            };
        } | {
            readonly type: "file";
            readonly file: {
                readonly filename: string;
                readonly file_data: string;
            };
        })[];
    } | {
        readonly [x: string]: unknown;
        readonly content: string | readonly {
            readonly type: "text";
            readonly text: string;
            readonly cache_control?: {
                readonly type: "ephemeral";
                readonly ttl?: string | undefined;
            } | undefined;
        }[] | null;
        readonly role: "assistant";
        readonly reasoning?: string | undefined;
        readonly reasoning_content?: string | undefined;
        readonly reasoning_text?: string | undefined;
        readonly tool_calls?: readonly {
            readonly function: {
                readonly name: string;
                readonly arguments: string;
            };
            readonly id: string;
            readonly type: "function";
            readonly extra_content?: {
                readonly google: {
                    readonly thought_signature: string;
                };
            } | undefined;
        }[] | undefined;
        readonly reasoning_details?: unknown;
    } | {
        readonly role: "tool";
        readonly tool_call_id: string;
        readonly content: string | readonly {
            readonly type: "text";
            readonly text: string;
            readonly cache_control?: {
                readonly type: "ephemeral";
                readonly ttl?: string | undefined;
            } | undefined;
        }[];
    })[];
    readonly stream: true;
    readonly max_completion_tokens?: number | undefined;
    readonly max_tokens?: number | undefined;
    readonly temperature?: number | undefined;
    readonly tools?: readonly {
        readonly function: {
            readonly description: string;
            readonly name: string;
            readonly parameters: {
                readonly [x: string]: unknown;
            };
            readonly strict?: boolean | undefined;
        };
        readonly type: "function";
        readonly cache_control?: {
            readonly type: "ephemeral";
            readonly ttl?: string | undefined;
        } | undefined;
    }[] | undefined;
    readonly stop?: readonly string[] | undefined;
    readonly seed?: number | undefined;
    readonly tool_choice?: "required" | "auto" | "none" | {
        readonly type: "function";
        readonly function: {
            readonly name: string;
        };
    } | undefined;
    readonly top_p?: number | undefined;
    readonly frequency_penalty?: number | undefined;
    readonly presence_penalty?: number | undefined;
    readonly store?: boolean | undefined;
    readonly prompt_cache_key?: string | undefined;
    readonly reasoning_effort?: import("../schema/options.js").ReasoningEffort | undefined;
    readonly stream_options?: {
        readonly include_usage: boolean;
    } | undefined;
    readonly tool_stream?: boolean | undefined;
}, import("../route/transport/http.js").HttpPrepared<string>, import("../route/client.js").CompactionOperations | undefined>)[];
export declare const configure: (input?: LanguageModelOptions) => {
    id: string & import("effect/Brand").Brand<"AI.ProviderID">;
    model: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<{
        readonly thinking?: {
            readonly type?: "enabled" | "disabled" | undefined;
            readonly tokenBudget?: number | undefined;
        } | undefined;
    }, import("../route/client.js").CompactionOperations | undefined>;
    chat: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<ChatOptionsInput, import("../route/client.js").CompactionOperations | undefined>;
    configure: (input?: LanguageModelOptions) => /*elided*/ any;
};
export declare const provider: {
    id: string & import("effect/Brand").Brand<"AI.ProviderID">;
    model: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<{
        readonly thinking?: {
            readonly type?: "enabled" | "disabled" | undefined;
            readonly tokenBudget?: number | undefined;
        } | undefined;
    }, import("../route/client.js").CompactionOperations | undefined>;
    chat: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<ChatOptionsInput, import("../route/client.js").CompactionOperations | undefined>;
    configure: (input?: LanguageModelOptions) => {
        id: string & import("effect/Brand").Brand<"AI.ProviderID">;
        model: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<{
            readonly thinking?: {
                readonly type?: "enabled" | "disabled" | undefined;
                readonly tokenBudget?: number | undefined;
            } | undefined;
        }, import("../route/client.js").CompactionOperations | undefined>;
        chat: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<ChatOptionsInput, import("../route/client.js").CompactionOperations | undefined>;
        configure: /*elided*/ any;
    };
};
export declare const model: ProviderPackage.Definition<Settings, CohereChat.ProviderOptionsInput>["model"];
export * as Cohere from "./cohere.js";
