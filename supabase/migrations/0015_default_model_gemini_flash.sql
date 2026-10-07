-- =============================================================================
-- 0015_default_model_gemini_flash.sql
--
-- New businesses start on Google Gemini 3.8 Flash for both replies and lead
-- extraction (Colin, 2026-10-07). The live tenant (VOLTA) was moved off Opus to
-- gemini-3.8-flash on 2026-09-16 because it answers quicker, but the column
-- defaults set in 0003 still said anthropic / claude-opus-5, so any business
-- created since would have started on the old model.
--
-- Defaults only: no existing row is touched, so tenants keep whatever model
-- they are already set to. 0003 is left exactly as it was applied.
-- =============================================================================

alter table public.business_settings
  alter column ai_provider         set default 'google',
  alter column ai_model            set default 'gemini-3.8-flash',
  alter column extraction_provider set default 'google',
  alter column extraction_model    set default 'gemini-3.8-flash';
