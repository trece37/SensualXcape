-- Compatible with existing clients: older messages may have no client ID.
alter table public.sx_messages add column if not exists client_message_id uuid;
create unique index if not exists sx_messages_sender_client_id_key
  on public.sx_messages(sender_id, client_message_id);
comment on column public.sx_messages.client_message_id is
  'Client-generated retry key. Unique per sender; retrying the same message cannot insert another row.';
