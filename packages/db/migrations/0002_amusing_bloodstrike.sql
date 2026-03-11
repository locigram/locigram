-- Phase 1: Structured Recall columns
ALTER TABLE "locigrams" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "locigrams" ADD COLUMN "predicate" text;--> statement-breakpoint
ALTER TABLE "locigrams" ADD COLUMN "object_val" text;--> statement-breakpoint
ALTER TABLE "locigrams" ADD COLUMN "durability_class" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "locigrams" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
CREATE INDEX "locigrams_subject_idx" ON "locigrams" USING btree ("palace_id","subject");--> statement-breakpoint
CREATE INDEX "locigrams_predicate_idx" ON "locigrams" USING btree ("palace_id","predicate");--> statement-breakpoint
CREATE INDEX "locigrams_durability_class_idx" ON "locigrams" USING btree ("palace_id","durability_class");--> statement-breakpoint
CREATE INDEX "locigrams_superseded_by_idx" ON "locigrams" USING btree ("superseded_by");
