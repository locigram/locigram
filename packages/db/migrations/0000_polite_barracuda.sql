CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"palace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locigrams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"connector" text,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"locus" text NOT NULL,
	"client_id" text,
	"importance" text DEFAULT 'normal' NOT NULL,
	"tier" text DEFAULT 'hot' NOT NULL,
	"is_reference" boolean DEFAULT false NOT NULL,
	"reference_type" text,
	"entities" text[] DEFAULT '{}' NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"embedding_id" text,
	"graph_synced_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"access_score" real DEFAULT 1 NOT NULL,
	"cluster_candidate" boolean DEFAULT false NOT NULL,
	"palace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"redirect_uris" text[] DEFAULT '{}' NOT NULL,
	"palace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"palace_id" text NOT NULL,
	"code_challenge" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "palaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_id" text NOT NULL,
	"api_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retrieval_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"palace_id" text NOT NULL,
	"query_text" text,
	"locigram_ids" text[] DEFAULT '{}' NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"locigram_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"raw_ref" text,
	"raw_url" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"palace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"palace_id" text NOT NULL,
	"source" text NOT NULL,
	"cursor" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "truths" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement" text NOT NULL,
	"locus" text NOT NULL,
	"entities" text[] DEFAULT '{}' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"source_count" integer DEFAULT 1 NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locigram_ids" uuid[] DEFAULT '{}' NOT NULL,
	"palace_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_palace_id_palaces_id_fk" FOREIGN KEY ("palace_id") REFERENCES "public"."palaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locigrams" ADD CONSTRAINT "locigrams_palace_id_palaces_id_fk" FOREIGN KEY ("palace_id") REFERENCES "public"."palaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_palace_id_palaces_id_fk" FOREIGN KEY ("palace_id") REFERENCES "public"."palaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_events" ADD CONSTRAINT "retrieval_events_palace_id_palaces_id_fk" FOREIGN KEY ("palace_id") REFERENCES "public"."palaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_locigram_id_locigrams_id_fk" FOREIGN KEY ("locigram_id") REFERENCES "public"."locigrams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_palace_id_palaces_id_fk" FOREIGN KEY ("palace_id") REFERENCES "public"."palaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "truths" ADD CONSTRAINT "truths_palace_id_palaces_id_fk" FOREIGN KEY ("palace_id") REFERENCES "public"."palaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entities_palace_name_unique" ON "entities" USING btree ("palace_id","name");--> statement-breakpoint
CREATE INDEX "entities_palace_id_idx" ON "entities" USING btree ("palace_id");--> statement-breakpoint
CREATE INDEX "entities_type_idx" ON "entities" USING btree ("palace_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "locigrams_source_ref_unique" ON "locigrams" USING btree ("palace_id","source_ref") WHERE source_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX "locigrams_palace_id_idx" ON "locigrams" USING btree ("palace_id");--> statement-breakpoint
CREATE INDEX "locigrams_locus_idx" ON "locigrams" USING btree ("palace_id","locus");--> statement-breakpoint
CREATE INDEX "locigrams_source_type_idx" ON "locigrams" USING btree ("palace_id","source_type");--> statement-breakpoint
CREATE INDEX "locigrams_connector_idx" ON "locigrams" USING btree ("palace_id","connector");--> statement-breakpoint
CREATE INDEX "locigrams_client_id_idx" ON "locigrams" USING btree ("palace_id","client_id");--> statement-breakpoint
CREATE INDEX "locigrams_tier_idx" ON "locigrams" USING btree ("palace_id","tier");--> statement-breakpoint
CREATE INDEX "locigrams_graph_synced_idx" ON "locigrams" USING btree ("palace_id","graph_synced_at");--> statement-breakpoint
CREATE INDEX "locigrams_is_reference_idx" ON "locigrams" USING btree ("palace_id","is_reference");--> statement-breakpoint
CREATE INDEX "locigrams_reference_type_idx" ON "locigrams" USING btree ("palace_id","reference_type");--> statement-breakpoint
CREATE INDEX "locigrams_occurred_at_idx" ON "locigrams" USING btree ("palace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "locigrams_created_at_idx" ON "locigrams" USING btree ("palace_id","created_at");--> statement-breakpoint
CREATE INDEX "locigrams_expires_at_idx" ON "locigrams" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_clients_palace_id_idx" ON "oauth_clients" USING btree ("palace_id");--> statement-breakpoint
CREATE INDEX "oauth_codes_client_id_idx" ON "oauth_codes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_codes_expires_idx" ON "oauth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sources_locigram_id_idx" ON "sources" USING btree ("locigram_id");--> statement-breakpoint
CREATE INDEX "sources_palace_id_idx" ON "sources" USING btree ("palace_id");--> statement-breakpoint
CREATE INDEX "sources_connector_idx" ON "sources" USING btree ("palace_id","connector");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_cursors_pk" ON "sync_cursors" USING btree ("palace_id","source");--> statement-breakpoint
CREATE INDEX "truths_palace_id_idx" ON "truths" USING btree ("palace_id");--> statement-breakpoint
CREATE INDEX "truths_locus_idx" ON "truths" USING btree ("palace_id","locus");--> statement-breakpoint
CREATE INDEX "truths_confidence_idx" ON "truths" USING btree ("palace_id","confidence");--> statement-breakpoint
CREATE INDEX "truths_last_seen_idx" ON "truths" USING btree ("last_seen");