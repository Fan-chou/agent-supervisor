import type { ProviderPackage } from "../provider-package.js";
import { VeniceChat } from "../protocols/venice-chat.js";
import { type ProviderAuthOption } from "../route/auth-options.js";
import { Route, type RouteDefaultsInput } from "../route/client.js";
import { type ModelID } from "../schema/index.js";
export declare const id: string & import("effect/Brand").Brand<"AI.ProviderID">;
export type ChatOptionsInput = VeniceChat.OptionsInput;
export type Config = Omit<RouteDefaultsInput, "providerOptions"> & ProviderAuthOption<"optional"> & {
    readonly baseURL?: string;
    readonly queryParams?: Readonly<Record<string, string>>;
    readonly providerOptions?: ChatOptionsInput;
};
export type Settings = ProviderPackage.Settings & ChatOptionsInput & {
    readonly apiKey?: string;
    readonly baseURL?: string;
    readonly queryParams?: Readonly<Record<string, string>>;
};
export declare const routes: Route<{
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
            readonly thought_signature?: string | undefined;
            readonly extra_content?: {
                readonly google: {
                    readonly thought_signature: string;
                };
            } | undefined;
        }[] | undefined;
        readonly thought_signature?: string | undefined;
        readonly reasoning_details?: unknown;
    })[];
    readonly stream: true;
    readonly venice_parameters: {
        readonly [x: string]: string | boolean;
    };
    readonly reasoning?: {
        readonly enabled?: boolean | undefined;
        readonly summary?: string | undefined;
        readonly effort?: string | undefined;
    } | undefined;
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
    readonly user?: string | undefined;
    readonly seed?: number | undefined;
    readonly tool_choice?: "required" | "auto" | "none" | {
        readonly type: "function";
        readonly function: {
            readonly name: string;
        };
    } | undefined;
    readonly top_p?: number | undefined;
    readonly top_k?: number | undefined;
    readonly frequency_penalty?: number | undefined;
    readonly presence_penalty?: number | undefined;
    readonly store?: boolean | undefined;
    readonly prompt_cache_key?: string | undefined;
    readonly parallel_tool_calls?: boolean | undefined;
    readonly reasoning_effort?: import("../schema/options.js").ReasoningEffort | undefined;
    readonly stream_options?: {
        readonly include_usage: boolean;
    } | undefined;
    readonly tool_stream?: boolean | undefined;
    readonly top_logprobs?: number | undefined;
    readonly prompt_cache_retention?: string | undefined;
    readonly repetition_penalty?: number | undefined;
    readonly response_format?: {
        readonly [x: string]: unknown;
    } | undefined;
    readonly logprobs?: boolean | undefined;
    readonly min_p?: number | undefined;
    readonly stop_token_ids?: readonly number[] | undefined;
    readonly max_temp?: number | undefined;
    readonly min_temp?: number | undefined;
}, import("../route/transport/http.js").HttpPrepared<string>, import("../route/client.js").CompactionOperations | undefined>[];
export declare const configure: (input?: Config) => {
    id: string & import("effect/Brand").Brand<"AI.ProviderID">;
    model: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<VeniceChat.OptionsInput, import("../route/client.js").CompactionOperations | undefined>;
    chat: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<VeniceChat.OptionsInput, import("../route/client.js").CompactionOperations | undefined>;
    configure: (input?: Config) => /*elided*/ any;
};
export declare const provider: {
    id: string & import("effect/Brand").Brand<"AI.ProviderID">;
    model: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<VeniceChat.OptionsInput, import("../route/client.js").CompactionOperations | undefined>;
    chat: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<VeniceChat.OptionsInput, import("../route/client.js").CompactionOperations | undefined>;
    configure: (input?: Config) => {
        id: string & import("effect/Brand").Brand<"AI.ProviderID">;
        model: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<VeniceChat.OptionsInput, import("../route/client.js").CompactionOperations | undefined>;
        chat: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<VeniceChat.OptionsInput, import("../route/client.js").CompactionOperations | undefined>;
        configure: /*elided*/ any;
    };
};
export declare const chat: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<VeniceChat.OptionsInput, import("../route/client.js").CompactionOperations | undefined>;
export declare const model: ProviderPackage.Definition<Settings, ChatOptionsInput>["model"];
export * as Venice from "./venice.js";
