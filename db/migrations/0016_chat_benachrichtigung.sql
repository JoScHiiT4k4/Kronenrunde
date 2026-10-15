-- Chat-Benachrichtigung per Push; standardmäßig stummgeschaltet.
alter table notification_prefs add column chat_push boolean not null default false;
