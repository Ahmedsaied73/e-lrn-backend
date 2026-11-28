# RAG Connection & Curriculum Quiz-Builder Blueprint

Your production VPS (`pgvector/pgvector:pg16` in `deploy/docker-compose.yml`) and migration (`20261127000000_enable_pgvector_if_available`) already have the `vector` PostgreSQL extension ready. Once the platform is live and stable, connect curriculum-grounded RAG in 4 clean steps:

## 1. Schema (`prisma/schema.prisma`)

Add a `CourseChunk` model using `Unsupported("vector(768)")`:

```prisma
model CourseChunk {
  id         Int                        @id @default(autoincrement())
  courseId   Int
  videoId    Int?
  chunkIndex Int
  content    String                     @db.Text
  metadata   Json?
  embedding  Unsupported("vector(768)")?
  createdAt  DateTime                   @default(now())

  course     Course                     @relation(fields: [courseId], references: [id], onDelete: Cascade)

  @@index([courseId])
}
```

Create a migration with an HNSW cosine index:

```sql
CREATE INDEX IF NOT EXISTS "CourseChunk_embedding_hnsw_idx"
  ON "CourseChunk" USING hnsw ("embedding" vector_cosine_ops);
```

## 2. Embedding & Chunking (Preserving Arabic + LaTeX / mhchem)

- Use `gemini-embedding-001` with `outputDimensionality: 768` via `GEMINI_API_KEY`.
- Chunk lesson PDFs/notes at `~600–900` tokens with `~100` token overlap, **never splitting inside `$$...$$`, `$...$`, or `\ce{...}`**.
- Store `courseId`, `videoId`, `lessonTitle`, and `pageNumber` in `metadata` so retrieved passages cite exact lessons.

## 3. Read-Only Retrieval Tool (`src/services/agent/tools/reads.js`)

Add a `search_curriculum` `readTool`:

```js
// Query with pgvector cosine distance (<=>), always scoped to courseId
const rows = await ctx.prisma.$queryRaw`
  SELECT id, "videoId", content, metadata,
         1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
  FROM "CourseChunk"
  WHERE "courseId" = ${course.id}
  ORDER BY embedding <=> ${vectorLiteral}::vector
  LIMIT ${topK}
`;
```

## 4. Quiz Generation Flow (Already Safety-Gated)

1. Teacher asks the Admin Agent: *"اعمل اختبار كيمياء 5 أسئلة من الدرس الثالث"*.
2. Agent calls `search_curriculum` (`readTool`) to retrieve exact curriculum definitions, equations, and examples.
3. Agent calls `upsert_quiz` (`confirmableActionTool` from Task 4), which validates all SurveyJS + `answerKey` + `math`/`chem` blocks and returns a preview summary + `confirmationToken`.
4. Teacher clicks **`تأكيد التنفيذ`** in `AgentChat.tsx` to persist the quiz.
