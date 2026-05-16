# Agents & Internal Components

SeekDeep uses several internal "agents" to handle different types of tasks. These agents are implemented as functions or modules within the main `index.js` file and are organized by responsibility.

## Chat Agent

**Purpose**: Handles conversational queries using the local chat model.

**Key Functions**:
- `askChat()` - Main chat function that handles prompting, system prompts, and web search integration
- `shouldAutoSearch()` - Determines if a prompt needs web search based on keywords
- `buildSystem()` - Constructs the system prompt with personality and behavior settings
- `runLocalChat()` - Sends chat requests to the local AI server
- `normalizeUserText()` - Cleans and normalizes user input
- `seekdeepResponseFooter()` - Adds metadata footer (time, model used) to responses

**Behavior**: Uses memory-safe contexts for follow-up conversations, supports automatic web search, and has anti-loop safeguards.

## Vision Agent

**Purpose**: Analyzes images and videos locally using the vision model.

**Key Functions**:
- `askVision()` - Processes attached media for vision analysis
- `seekdeepLooksLikeVisionPrompt()` - Detects if a prompt is a vision request
- `seekdeepAttachmentLooksVisual()` - Checks if an attachment is visual media

**Behavior**: Accepts image/video attachments and optional text prompts. Returns detailed descriptions of the media.

## Image Agent

**Purpose**: Generates images based on user prompts with optional refinement.

**Key Functions**:
- `makeImage()` - Main image generation function
- `makeImageResult()` - Handles the full image generation pipeline
- `seekdeepBuildImagePromptChoice()` - Prepares image prompts with optional refinement
- `seekdeepPrepareImagePrompt()` - Static prompt refinement logic
- `seekdeepPrepareImagePromptDynamic()` - Dynamic AI-based prompt refinement
- `seekdeepImagePromptHasAny()` - Checks if prompt contains specific keywords
- `seekdeepImageModeOptionsFromPrompt()` - Parses user options (raw/refined, grounding)

**Behavior**: Supports prompt refinement (static and dynamic), image grounding via web search, and multiple refinement modes.

## Web Search Agent

**Purpose**: Provides internet search capabilities through SearXNG.

**Key Functions**:
- `searchWeb()` - Performs web search via SearXNG API
- `formatSources()` - Formats search results for display
- `shouldAutoSearch()` - Decides when to automatically trigger web search

**Behavior**: Returns search context and sources. Integrates with chat and image agents for grounded prompts.

## Archive Agent

**Purpose**: Manages image storage and retrieval.

**Key Functions**:
- `seekdeepArchiveImageStateToDisk()` - Saves generated images to disk
- `seekdeepArchiveTargetFallback()` - Determines archive target from interaction
- `seekdeepArchiveScopedKey()` - Creates unique archive keys per scope
- `seekdeepRememberImageAction()` - Tracks image actions for display
- `seekdeepImageQueueStatusText()` - Shows archive status

**Behavior**: Images are saved to `saved_generations/` with timestamps. Supports guild-level and DM-level archives.

## Natural Routing Agent

**Purpose**: Intelligently routes user messages to the appropriate agent.

**Key Functions**:
- `seekdeepInferNaturalRoute()` - Main routing function for messages
- `seekdeepLooksLikeImagePrompt()` - Detects image generation intent
- `seekdeepLooksLikeVisionPrompt()` - Detects vision analysis intent
- `seekdeepHasExplicitImageRequest()` - Checks for explicit image commands
- `seekdeepShouldStayChatInsteadOfImage()` - Prevents image routing for text questions

**Behavior**: Analyzes user input and attachments to determine whether to route to chat, vision, or image agent.

## Prompt Refinement Agent

**Purpose**: Improves and refines user prompts using AI.

**Key Functions**:
- `seekdeepCleanRefinedPrompt()` - Cleans AI-refined prompts
- `removeRepeatedSentences()` - Removes duplicate sentences from refined prompts
- `seekdeepBuildDynamicImagePromptRefineRequest()` - Constructs refinement requests
- `seekdeepImagePromptHasAny()` - Checks prompt keywords for refinement rules

**Behavior**: Supports static and dynamic prompt refinement. Static uses keyword-based rules, dynamic uses AI model.

## Queue & Cooldown Manager

**Purpose**: Manages image generation queue and cooldown periods.

**Key Functions**:
- `seekdeepPumpImageQueue()` - Processes queued image jobs
- `seekdeepImageQueueStatusText()` - Shows queue status
- `seekdeepImageCooldownRemaining()` - Checks cooldown status
- `seekdeepImageQueueAckText()` - Queue acknowledgment messages

**Behavior**: Supports per-user cooldowns and queue management for image generation.

## Response Helpers

**Purpose**: Utilities for generating consistent response formatting.

**Key Functions**:
- `seekdeepAppendResponseFooter()` - Adds metadata to responses
- `seekdeepCleanPublicReportText()` - Cleans public response text
- `seekdeepCompactQueueSummary()` - Summarizes queue messages
- `seekdeepNormalizeLoopLine()` - Normalizes loop lines for deduplication
- `cleanLoopingReply()` - Removes loops from AI responses

## Integration Points

All agents interact through the main Discord client event handlers:
- Message interactions → Natural Router → Appropriate Agent
- Slash commands → Direct agent calls
- Button interactions → Image Agent (regeneration, archive actions)
- Webhook calls → Local AI Server → Response formatting
