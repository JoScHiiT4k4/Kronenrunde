-- Emoji-Reaktionen auf Chat-Nachrichten: je Nutzer, Nachricht und Emoji einmal; verschwinden mit der Nachricht.
create table chat_reactions (
  message_id bigint not null references chat_messages (id) on delete cascade,
  user_id    uuid   not null references users (id) on delete cascade,
  emoji      text   not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
