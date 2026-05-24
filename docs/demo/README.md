# SeekDeep Demo Walkthrough Guide

This directory acts as a guide and script template for demonstrating SeekDeep's full capabilities during live trials, stakeholder reviews, or tutorial videos.

## Proposed Demo Flow

### 1. Verification and Health Check
- **Step 1**: Run local diagnostic tool:
  ```bash
  npm run doctor
  ```
- **Step 2**: Boot the server and bot:
  ```bash
  start_all.bat
  ```
- **Step 3**: Verify the boot output log contains the consolidated ASCII System Health Report with zero failures.

### 2. Conversational Capabilities & Memory Presets
- **Step 1 (Persona Tuning)**: Set channel persona to neurotic:
  ```
  @SeekDeep persona channel neurotic
  ```
  - Ask: `"How are you feeling today?"` (Verify response style fits).
- **Step 2 (User Memory Presets)**: Configure user memory:
  ```
  @SeekDeep memory preset add brief
  ```
  - Ask: `"Explain photosythesis in one sentence."` (Verify short concise output).
- **Step 3 (Recall memory)**: Ask about a previous topic in the thread to verify memory.

### 3. Web Grounded Search
- **Step 1 (Auto search trigger)**: Ask:
  ```
  @SeekDeep who won the latest Formula 1 Grand Prix?
  ```
  - Verify SearXNG triggers automatically, and bot includes sources in the footer.

### 4. Vision and OCR Analysis
- **Step 1 (Visual description)**: Upload an image (e.g. a schematic or abstract art) and ask:
  ```
  @SeekDeep what is this and explain its components
  ```
- **Step 2 (OCR Text Extraction)**: Upload a receipt or code screenshot and ask:
  ```
  @SeekDeep transcribe the text in this image --ocr
  ```

### 5. Premium Image Generation
- **Step 1 (Prompt Choice preview)**: Run:
  ```
  /image prompt: a neon cyberpunk cat walking through rain, cinematic lighting, 8k
  ```
  - Verify original / refined choices are generated.
- **Step 2 (Image rendering)**: Click "Both" to enqueue both versions. Verify execution speed and model switching logs.
- **Step 3 (Interactive edits)**: Reply to one of the completed images:
  ```
  make the cat a robot instead
  ```
  - Verify the bot classifies this as a modification intent and runs `img2img`.

### 6. Admin and Diagnostics Controls
- **Step 1 (GPU check)**: Run `@SeekDeep status verbose` to check VRAM residents.
- **Step 2 (Unload models)**: Run `@SeekDeep unload` to clear CUDA VRAM memory pool.
- **Step 3 (Permissions check)**: Run `@SeekDeep permissions` to verify channel capabilities.
