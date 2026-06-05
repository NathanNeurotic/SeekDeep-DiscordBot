# Disclaimer, Terms of Use & Liability Notice

> **Plain-language summary.** SeekDeep is free, open-source software provided **"as is", with no warranty**. It is a **frontend / orchestration layer** — a Discord bot and a local web GUI — that talks to **third-party AI models and services the maintainer does not create, own, train, host, or control.** **You are solely responsible for how you use it, for anything you generate with it, and for complying with the law and with every third-party service's terms.** The maintainer is **not liable** for your use or misuse of the software.
>
> This document is **not legal advice**. If you operate SeekDeep commercially or at scale, consult a qualified attorney for a binding Terms of Service tailored to your situation.

## 1. No warranty

SeekDeep is licensed under the **GNU General Public License v2.0** (see [LICENSE](LICENSE)). As stated there, the program is provided **WITHOUT ANY WARRANTY** — without even the implied warranty of **MERCHANTABILITY** or **FITNESS FOR A PARTICULAR PURPOSE**. The entire risk as to the quality and performance of the software is with you. Should the software prove defective, you assume the cost of all necessary servicing, repair, or correction.

## 2. What SeekDeep is (and is not)

SeekDeep is a **client and orchestration layer**:

- a **Discord bot** (`index.js`) and a **local web GUI**, served by a **local Python server** (`local_ai_server.py`);
- it **routes requests to, and renders outputs from, third-party AI models and services.**

SeekDeep does **not** create, train, own, host, or control any AI model, and it does not itself generate content. All model weights, inference, and generated outputs come from **third parties you choose to enable**, including but not limited to:

- **AI model providers** — Hugging Face Hub models, Ollama, and any optional remote backends you configure (OpenAI-compatible, Anthropic, Google Gemini, etc.);
- **Discord** — the platform the bot operates on;
- **SearXNG** and the upstream search engines it queries.

Each of these is governed by **its own license, terms of service, acceptable-use policy, and privacy policy**, which **you** are responsible for reading and following. The maintainer of SeekDeep has no control over — and accepts no responsibility for — those services, their availability, their data practices, or the content they return.

## 3. Your responsibilities

By installing, running, or using SeekDeep, **you agree that you are solely responsible for:**

- **All content you generate, request, store, transmit, or display** with SeekDeep — including text, images, audio, and any other output of the underlying models;
- **Your compliance with all applicable laws and regulations** in your jurisdiction;
- **Your compliance with the terms of every third-party service** you connect SeekDeep to — including **Discord's Terms of Service and Community Guidelines**, and each model/search provider's acceptable-use policy;
- **Operating your own Discord bot/application responsibly**, including obtaining any consent required from server members and handling their data appropriately;
- **Securing your own credentials** (Discord token, API keys) and your own deployment and hardware.

## 4. Acceptable use

You must **not** use SeekDeep to create, distribute, or facilitate:

- content that is **illegal** in your jurisdiction;
- **child sexual abuse material**, or any content that sexualizes minors;
- **harassment, threats, doxxing, or targeted abuse**;
- **malware, fraud, spam**, or attempts to compromise others' systems, accounts, or data;
- content that **violates the terms** of Discord or of any model/service provider you use.

This list is **illustrative, not exhaustive**. Generative AI models can and do produce **inaccurate, biased, offensive, or otherwise harmful** output. **You are responsible for reviewing what the models produce and for how you use it.** Do not rely on any output as professional (legal, medical, financial, safety-critical) advice.

## 5. Limitation of liability

To the maximum extent permitted by applicable law, **the author(s) and contributors of SeekDeep shall not be liable** for any claim, damages, loss, or other liability — whether in an action of contract, tort, or otherwise — arising from, out of, or in connection with the software or its use, including without limitation:

- any **content or output** produced by the third-party models SeekDeep orchestrates;
- any **misuse** of the software by you or by users of a bot you operate;
- any **act, omission, outage, change of terms, or data practice** of any third-party service;
- any **data loss, hardware wear, downtime, or security incident** on your deployment.

You use SeekDeep **at your own risk** and **assume full responsibility** for your use and for any consequences of it.

## 6. Indemnification

To the extent permitted by law, you agree to **indemnify and hold harmless** the author(s) and contributors from any claim or demand — including reasonable legal fees — made by any third party arising out of **your** use of SeekDeep, **your** generated content, or **your** violation of this notice, of any law, or of any third party's rights.

## 7. No affiliation / trademarks

SeekDeep is an independent open-source project and is **not affiliated with, endorsed by, or sponsored by** Discord, Hugging Face, Ollama, OpenAI, Anthropic, Google, or any other third party. Product and company names mentioned are the trademarks of their respective owners and are used only for identification.

## 8. Changes

This notice may change as the project evolves; the version present in the repository at the time you obtain or use SeekDeep applies to your use.

---

*This disclaimer is provided in good faith as a template for an open-source project and is **not legal advice**, nor does it create an attorney–client relationship. Laws vary by jurisdiction. For a binding Terms of Service or for advice on your specific circumstances, consult a licensed attorney.*
