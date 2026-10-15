-- Schimpfwortfilter im Chat: je Teilnehmer, standardmäßig an (Wörter erscheinen als Sterne).
alter table notification_prefs add column chat_filter boolean not null default true;
