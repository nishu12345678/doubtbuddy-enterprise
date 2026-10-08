# Tutor conversations and image review

## Follow-ups

Completed `### Step N` headings have **Ask about this step** buttons. Hindi, Malayalam, Tamil, Telugu and several other localized step labels, as well as `3a` substeps, are recognized. The selected number, title and answer ID are sent with the student's question:

```js
socket.emit('followup-query', {
  question: 'How did 2gh appear here?',
  step_number: '3',
  step_title: 'Apply energy conservation',
  answer_id: previousSolution.requestId
});
```

The backend verifies numbered steps against its stored answer headings when `answer_id` is provided. The client cannot replace that answer's title. General follow-ups omit the three step fields. Legacy `{ step, question }` payloads and arrays remain supported. A separate FOLLOW-UP MODE developer message is inserted immediately before the current user message and overrides the full-answer template. It asks for focused explanations, prerequisite teaching and respectful corrections rather than re-solving the whole problem.

Each solving call includes the main tutor instructions, original question/image and first solution, plus all earlier follow-ups until ten have accumulated. Before the next follow-up or suggestion request, older follow-ups are summarized while the original pair and the latest four follow-up pairs remain verbatim. The summary retains corrections, misconceptions, language, level and unresolved questions. Summarization repeats as needed and its tokens are added to that request's usage without a second request quota reservation. Failed summarization returns an error without silently dropping context. A summary can lose detail; the student can quote an older point when needed.

Context is private to the current socket and is lost on disconnect or server restart. Reconnecting starts a fresh backend conversation; use New question to start again. This is not durable chat storage. The original image is not discarded during compaction within a connected conversation.

## Language and student profile

Every answer must match the latest student's language, including headings and the closing question: English gets complete English, Hindi gets Hindi, Malayalam gets Malayalam, and similarly for other languages. Mixed language is used only when the student uses or requests it. Explicit language requests take priority. Equations and conventional unit symbols remain standard notation.

Under **Learning preferences**, the student can set class, exam, language and difficulty. The language field supplies a fallback for language-ambiguous images/equations; it does not override a clearly different language in the current question. These are prompt instructions, not a guarantee that model output will always be linguistically perfect.

`text-query`, `image-query`, `image-extract` and each follow-up item accept:

```json
{
  "profile": {
    "classLevel": "Class 11",
    "examTarget": "JEE Advanced",
    "language": "Malayalam",
    "difficulty": "advanced"
  }
}
```

Difficulty is `auto`, `standard`, or `advanced`. Exam target is `School`, `JEE Main`, `JEE Advanced`, `NEET`, or empty. Class and language are bounded strings. Profile settings persist across follow-ups and are replaced on a new text/image question.

## Optional image extraction

**Read image before solving** makes a separate extraction call. It displays the seven requested fields: QUESTION_TEXT, OPTIONS, DIAGRAM_DESCRIPTION, SUBJECT_GUESS, LEVEL_GUESS, MULTIPLE_QUESTIONS and UNCLEAR_PARTS. Students can correct the extracted text before solving. The extractor has its own scoped instructions and a strict JSON schema internally; the server formats that object into the labelled text shown to the student. It does not run the full tutor-solution prompt.

Emit `image-extract` with the same image payload as `image-query`. Receive `image-extraction-result: { content, requestId }`, followed by the terminal `query-response-solution` with `kind: "extract"`. Extraction does not stream solution chunks or replace the existing conversation. It consumes one request. The separate solve consumes another.

To solve the reviewed question, emit `image-query` with the original `fileContent`, `fileName`, optional typed `textQuestion`, and `extractedText` (max 24,000 characters). Both the image and reviewed extraction reach the solver, which is instructed to clarify conflicts. Images use Responses API `input_image` content parts with `detail: "high"`; this differs from the Chat Completions example's `image_url` shape.

## Model routing

Standard requests use `OPENAI_MODEL` (default `gpt-4.1-mini`) and temperature 0.3 for non-reasoning models. Explicit Advanced difficulty or JEE Advanced with Auto difficulty routes solving/follow-ups to `OPENAI_REASONING_MODEL` (default `gpt-5-mini`). Set that environment variable to an empty value to disable routing. Standard difficulty overrides automatic JEE Advanced routing. This is profile-based routing, not a classifier of arbitrary problem difficulty.

Reasoning models omit temperature, use medium reasoning effort, and receive an 8,192-token output budget. Standard solving has 4,096 output tokens. Extraction, summarization and suggestions use the standard configured model. Account access is required; errors are shown instead of silently downgrading. See the official [reasoning model guidance](https://developers.openai.com/api/docs/guides/reasoning) and [GPT-5 mini documentation](https://developers.openai.com/api/docs/models/gpt-5-mini).

## Verification

`npm test` covers prompt ordering, profile forwarding, step validation, long-thread compaction, retained images, extraction separation, model parameters, authentication and usage. `npm run test:browser` checks the step button, editable extraction and image-plus-text flow with an explicitly labelled demo provider.

`node --env-file=.env tests/live-followup.js` is an opt-in six-request live check against the running server: extraction, reviewed image solving, a Hindi step follow-up, a Malayalam general follow-up, an English language switch and the reasoning route. This uses the configured OpenAI account and revokes its temporary partner key afterward. It is not part of the ordinary offline test suite.
