CREATE TABLE "connector_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"palace_id" text NOT NULL,
	"connector_type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"schedule" text,
	"cursor" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"items_synced" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"items_pulled" integer DEFAULT 0 NOT NULL,
	"items_pushed" integer DEFAULT 0 NOT NULL,
	"items_skipped" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"cursor_before" jsonb,
	"cursor_after" jsonb,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"palace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "service" text;--> statement-breakpoint
ALTER TABLE "connector_instances" ADD CONSTRAINT "connector_instances_palace_id_palaces_id_fk" FOREIGN KEY ("palace_id") REFERENCES "public"."palaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_syncs" ADD CONSTRAINT "connector_syncs_instance_id_connector_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."connector_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_instances_palace_idx" ON "connector_instances" USING btree ("palace_id");--> statement-breakpoint
CREATE INDEX "connector_instances_type_idx" ON "connector_instances" USING btree ("palace_id","connector_type");--> statement-breakpoint
CREATE INDEX "connector_syncs_instance_idx" ON "connector_syncs" USING btree ("instance_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_access_tokens_hash_idx" ON "oauth_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_client_idx" ON "oauth_access_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_palace_idx" ON "oauth_access_tokens" USING btree ("palace_id");