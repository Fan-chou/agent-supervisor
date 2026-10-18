import type { RouteDefaultsInput } from "../route/client.js";
import type { ProviderAuthOption } from "../route/auth-options.js";
import type { ProviderPackage } from "../provider-package.js";
import { type ModelID } from "../schema/index.js";
import { Gemini } from "../protocols/gemini.js";
import { GoogleInteractions } from "../protocols/google-interactions.js";
export type { GoogleImageOptions } from "../protocols/google-images.js";
export type { GoogleSpeechOptions } from "../protocols/google-speech.js";
export type { GoogleTranscriptionOptions } from "../protocols/google-transcription.js";
export type { GoogleVideoOptions } from "../protocols/google-video.js";
export type GeminiOptionsInput = Gemini.OptionsInput;
export type GeminiProviderOptionsInput = Gemini.ProviderOptionsInput;
export type GoogleInteractionsOptionsInput = GoogleInteractions.OptionsInput;
export declare const id: string & import("effect/Brand").Brand<"AI.ProviderID">;
export declare const routes: (import("../route/client.js").Route<{
    readonly contents: readonly {
        readonly parts?: readonly ({
            readonly inlineData: {
                readonly mimeType: string;
                readonly data: string;
            };
            readonly thoughtSignature?: string | null | undefined;
        } | {
            readonly text: string;
            readonly thought?: boolean | null | undefined;
            readonly thoughtSignature?: string | null | undefined;
        } | {
            readonly fileData: {
                readonly mimeType: string;
                readonly fileUri: string;
            };
        } | {
            readonly functionCall: {
                readonly name: string;
                readonly id?: string | null | undefined;
                readonly args?: unknown;
            };
            readonly thoughtSignature?: string | null | undefined;
        } | {
            readonly functionResponse: {
                readonly name: string;
                readonly response: unknown;
                readonly id?: string | undefined;
                readonly parts?: readonly {
                    readonly inlineData: {
                        readonly mimeType: string;
                        readonly data: string;
                    };
                    readonly thoughtSignature?: string | null | undefined;
                }[] | undefined;
            };
        })[] | null | undefined;
        readonly role?: "model" | "user" | null | undefined;
    }[];
    readonly tools?: readonly {
        readonly functionDeclarations: readonly {
            readonly name: string;
            readonly description: string;
            readonly parametersJsonSchema: {
                readonly [x: string]: unknown;
            };
        }[];
    }[] | undefined;
    readonly serviceTier?: string | undefined;
    readonly toolConfig?: {
        readonly functionCallingConfig: {
            readonly mode: "NONE" | "AUTO" | "ANY";
            readonly allowedFunctionNames?: readonly string[] | undefined;
        };
    } | undefined;
    readonly cachedContent?: string | undefined;
    readonly safetySettings?: readonly {
        readonly category: import("../schema/options.js").OpenString<"HARM_CATEGORY_UNSPECIFIED" | "HARM_CATEGORY_HATE_SPEECH" | "HARM_CATEGORY_DANGEROUS_CONTENT" | "HARM_CATEGORY_HARASSMENT" | "HARM_CATEGORY_SEXUALLY_EXPLICIT" | "HARM_CATEGORY_CIVIC_INTEGRITY">;
        readonly threshold: import("../schema/options.js").OpenString<"HARM_BLOCK_THRESHOLD_UNSPECIFIED" | "BLOCK_LOW_AND_ABOVE" | "BLOCK_MEDIUM_AND_ABOVE" | "BLOCK_ONLY_HIGH" | "BLOCK_NONE" | "OFF">;
    }[] | undefined;
    readonly labels?: {
        readonly [x: string]: string;
    } | undefined;
    readonly systemInstruction?: {
        readonly parts: readonly {
            readonly text: string;
        }[];
    } | undefined;
    readonly generationConfig?: {
        readonly temperature?: number | undefined;
        readonly topP?: number | undefined;
        readonly topK?: number | undefined;
        readonly frequencyPenalty?: number | undefined;
        readonly presencePenalty?: number | undefined;
        readonly seed?: number | undefined;
        readonly stopSequences?: readonly string[] | undefined;
        readonly thinkingConfig?: {
            readonly thinkingBudget?: number | undefined;
            readonly includeThoughts?: boolean | undefined;
            readonly thinkingLevel?: import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high"> | undefined;
        } | undefined;
        readonly maxOutputTokens?: number | undefined;
    } | undefined;
    readonly continuationToken?: string | undefined;
}, Gemini.Prepared, import("../route/client.js").CompactionOperations | undefined> | import("../route/client.js").Route<{
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
}, import("../route/transport/http.js").HttpPrepared<string>, import("../route/client.js").CompactionOperations | undefined>)[];
export type Config = RouteDefaultsInput & ProviderAuthOption<"optional"> & {
    readonly baseURL?: string;
    readonly providerOptions?: Gemini.ProviderOptionsInput & GoogleInteractions.ProviderOptionsInput;
};
export type Settings = ProviderPackage.Settings & Gemini.ProviderOptionsInput & {
    readonly apiKey?: string;
    readonly baseURL?: string;
};
export declare const configure: (input?: Config) => {
    id: string & import("effect/Brand").Brand<"AI.ProviderID">;
    model: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<Gemini.OptionsInput, import("../route/client.js").CompactionOperations | undefined>;
    interactions: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<{
        readonly serviceTier?: import("../schema/options.js").OpenString<"standard" | "flex" | "priority" | "deferred"> | undefined;
        readonly thinkingLevel?: import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high"> | undefined;
        readonly previousInteractionId?: string | undefined;
        readonly store?: boolean | undefined;
        readonly thinkingSummaries?: import("../schema/options.js").OpenString<"auto" | "none"> | undefined;
    }, import("../route/client.js").CompactionOperations | undefined>;
    image: (modelID: string | ModelID) => import("../image.js").ImageModel<import("../protocols/google-images.js").GoogleImageOptions>;
    video: (modelID: string | ModelID) => import("../video.js").VideoModel<import("../protocols/google-video.js").GoogleVideoOptions>;
    speech: (modelID: string | ModelID) => import("../speech.js").SpeechModel<import("../protocols/google-speech.js").GoogleSpeechOptions>;
    transcription: (modelID: string | ModelID) => import("../transcription.js").TranscriptionModel<import("../protocols/google-transcription.js").GoogleTranscriptionOptions>;
    configure: (input?: Config) => /*elided*/ any;
};
export declare const provider: {
    id: string & import("effect/Brand").Brand<"AI.ProviderID">;
    model: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<Gemini.OptionsInput, import("../route/client.js").CompactionOperations | undefined>;
    interactions: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<{
        readonly serviceTier?: import("../schema/options.js").OpenString<"standard" | "flex" | "priority" | "deferred"> | undefined;
        readonly thinkingLevel?: import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high"> | undefined;
        readonly previousInteractionId?: string | undefined;
        readonly store?: boolean | undefined;
        readonly thinkingSummaries?: import("../schema/options.js").OpenString<"auto" | "none"> | undefined;
    }, import("../route/client.js").CompactionOperations | undefined>;
    image: (modelID: string | ModelID) => import("../image.js").ImageModel<import("../protocols/google-images.js").GoogleImageOptions>;
    video: (modelID: string | ModelID) => import("../video.js").VideoModel<import("../protocols/google-video.js").GoogleVideoOptions>;
    speech: (modelID: string | ModelID) => import("../speech.js").SpeechModel<import("../protocols/google-speech.js").GoogleSpeechOptions>;
    transcription: (modelID: string | ModelID) => import("../transcription.js").TranscriptionModel<import("../protocols/google-transcription.js").GoogleTranscriptionOptions>;
    configure: (input?: Config) => {
        id: string & import("effect/Brand").Brand<"AI.ProviderID">;
        model: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<Gemini.OptionsInput, import("../route/client.js").CompactionOperations | undefined>;
        interactions: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<{
            readonly serviceTier?: import("../schema/options.js").OpenString<"standard" | "flex" | "priority" | "deferred"> | undefined;
            readonly thinkingLevel?: import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high"> | undefined;
            readonly previousInteractionId?: string | undefined;
            readonly store?: boolean | undefined;
            readonly thinkingSummaries?: import("../schema/options.js").OpenString<"auto" | "none"> | undefined;
        }, import("../route/client.js").CompactionOperations | undefined>;
        image: (modelID: string | ModelID) => import("../image.js").ImageModel<import("../protocols/google-images.js").GoogleImageOptions>;
        video: (modelID: string | ModelID) => import("../video.js").VideoModel<import("../protocols/google-video.js").GoogleVideoOptions>;
        speech: (modelID: string | ModelID) => import("../speech.js").SpeechModel<import("../protocols/google-speech.js").GoogleSpeechOptions>;
        transcription: (modelID: string | ModelID) => import("../transcription.js").TranscriptionModel<import("../protocols/google-transcription.js").GoogleTranscriptionOptions>;
        configure: /*elided*/ any;
    };
};
export declare const model: ProviderPackage.Definition<Settings, Gemini.ProviderOptionsInput>["model"];
export declare const image: (modelID: string | ModelID) => import("../image.js").ImageModel<import("../protocols/google-images.js").GoogleImageOptions>;
export declare const interactions: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<{
    readonly serviceTier?: import("../schema/options.js").OpenString<"standard" | "flex" | "priority" | "deferred"> | undefined;
    readonly thinkingLevel?: import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high"> | undefined;
    readonly previousInteractionId?: string | undefined;
    readonly store?: boolean | undefined;
    readonly thinkingSummaries?: import("../schema/options.js").OpenString<"auto" | "none"> | undefined;
}, import("../route/client.js").CompactionOperations | undefined>;
export declare const video: (modelID: string | ModelID) => import("../video.js").VideoModel<import("../protocols/google-video.js").GoogleVideoOptions>;
export declare const speech: (modelID: string | ModelID) => import("../speech.js").SpeechModel<import("../protocols/google-speech.js").GoogleSpeechOptions>;
export declare const transcription: (modelID: string | ModelID) => import("../transcription.js").TranscriptionModel<import("../protocols/google-transcription.js").GoogleTranscriptionOptions>;
