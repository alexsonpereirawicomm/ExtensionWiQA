// Conexão fixa com o Supabase de produção do WiControl. Os dois valores são
// públicos (a anon key só identifica o projeto; o acesso é controlado pela Edge
// Function com token do projeto + senha de convidado), por isso podem ficar no
// pacote da extensão. Ao trocar de projeto, atualize também host_permissions no
// manifest.json.
//
// Para desenvolver contra o Supabase local (`supabase start` no WiControl), troque
// temporariamente por http://127.0.0.1:54421 e pela chave local do `supabase status`.
export const SUPABASE_URL = 'https://gfzsahqvxloggzlvrpxr.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdmenNhaHF2eGxvZ2d6bHZycHhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwODUzODIsImV4cCI6MjA4ODY2MTM4Mn0.oSsvN2xXfZj92V_clTDo7zXnZUS5AMCzKe2t8JdDzLY';
