require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const now = Date.now();

const demoLeads = [
  {
    id: 'demo-ventas-contactado-sin-cuil',
    nf: 'Demo Contactado Sin CUIL',
    rs: 'Panaderia Norte',
    cuit: '',
    ca: 'Gastronomia',
    ntel: '',
    ta: 'Gestion de redes',
    estado: 'contactado',
    position: 1,
    minutesAgo: 15,
    note: 'Lead demo en contactado sin CUIL. En la vista expandida debe verse "Sin CUIL *".',
  },
  {
    id: 'demo-ventas-contactado-cuil-ejemplo',
    nf: 'Demo CUIL Ejemplo',
    rs: 'Taller Ruta 8',
    cuit: '30-12345678-9',
    ca: 'Automotor',
    ntel: '',
    ta: 'Landing page',
    estado: 'contactado',
    position: 2,
    minutesAgo: 40,
    note: 'Lead demo con el CUIL de ejemplo viejo. Visualmente debe tratarse como faltante.',
  },
  {
    id: 'demo-ventas-contactado-cuil-real',
    nf: 'Demo Contactado Con CUIL',
    rs: 'Estudio Delta SRL',
    cuit: '30-87654321-5',
    ca: 'Servicios profesionales',
    ntel: '',
    ta: 'Sistema de turnos',
    estado: 'contactado',
    position: 3,
    minutesAgo: 70,
    note: 'Lead demo con CUIL real para comparar la insignia.',
  },
  {
    id: 'demo-ventas-seguimiento-sin-cuil',
    nf: 'Demo Seguimiento Sin CUIL',
    rs: 'Consultorio Sur',
    cuit: '',
    ca: 'Salud',
    ntel: '',
    ta: 'Automatizacion de consultas',
    estado: 'seguimiento',
    position: 1,
    minutesAgo: 120,
    note: 'Lead demo en seguimiento sin CUIL. Debe verse "Sin CUIL", sin asterisco.',
  },
  {
    id: 'demo-ventas-seguimiento-real',
    nf: 'Demo Seguimiento Con CUIL',
    rs: 'Distribuidora Oeste SA',
    cuit: '30-99887766-4',
    ca: 'Distribucion',
    ntel: '',
    ta: 'CRM comercial',
    estado: 'seguimiento',
    position: 2,
    minutesAgo: 180,
    note: 'Lead demo en seguimiento con CUIL real.',
  },
  {
    id: 'demo-ventas-presupuestado-sin-cuil',
    nf: 'Demo Presupuestado Sin CUIL',
    rs: 'Local Centro',
    cuit: '',
    ca: 'Retail',
    ntel: '',
    ta: 'Ecommerce',
    estado: 'presupuestado',
    position: 1,
    minutesAgo: 240,
    note: 'Lead demo en el tablero principal de ventas sin CUIL.',
  },
  {
    id: 'demo-ventas-reunion-cuil-real',
    nf: 'Demo Reunion Con CUIL',
    rs: 'Constructora Prisma',
    cuit: '30-11223344-8',
    ca: 'Construccion',
    ntel: '',
    ta: 'Web institucional',
    estado: 'reunion',
    position: 1,
    minutesAgo: 300,
    note: 'Lead demo en reunion con CUIL real.',
  },
];

async function ensureEstadoSeguimiento() {
  await pool.query("ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_estado_check");
  await pool.query(
    "ALTER TABLE cards ADD CONSTRAINT cards_estado_check CHECK (estado IN ('iniciada', 'en_proceso', 'finalizado', 'contactado', 'seguimiento', 'presupuestado', 'reunion', 'venta_exitosa', 'papelera'))"
  );
}

async function main() {
  await ensureEstadoSeguimiento();

  for (const lead of demoLeads) {
    const creadoEn = now - lead.minutesAgo * 60 * 1000;
    await pool.query(
      `INSERT INTO cards (
         id, nf, rs, cuit, ca, ntel, t, ta, c, color, estado, equipo,
         usuario, usuarios, creado_por, creado_en, position
       )
       VALUES ($1,$2,$3,$4,$5,$6,'',$7,$8,'none',$9,'ventas',NULL,'[]'::jsonb,NULL,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         nf = EXCLUDED.nf,
         rs = EXCLUDED.rs,
         cuit = EXCLUDED.cuit,
         ca = EXCLUDED.ca,
         ntel = EXCLUDED.ntel,
         ta = EXCLUDED.ta,
         c = EXCLUDED.c,
         estado = EXCLUDED.estado,
         equipo = 'ventas',
         position = EXCLUDED.position,
         deleted_at = NULL,
         updated_at = NOW()`,
      [
        lead.id,
        lead.nf,
        lead.rs,
        lead.cuit,
        lead.ca,
        lead.ntel,
        lead.ta,
        lead.note,
        lead.estado,
        creadoEn,
        lead.position,
      ]
    );

    await pool.query(
      `INSERT INTO card_description_history (id, card_id, user_id, description, creado_en, created_at)
       VALUES ($1, $2, NULL, $3, $4::bigint, to_timestamp($4::double precision / 1000.0))
       ON CONFLICT (id) DO UPDATE SET
         description = EXCLUDED.description,
         creado_en = EXCLUDED.creado_en,
         created_at = EXCLUDED.created_at`,
      ['history-' + lead.id, lead.id, lead.note, creadoEn]
    );
  }

  console.log(`Leads demo creados/actualizados: ${demoLeads.length}`);
  console.log('Abrir Ventas > Contactados para ver las columnas Leads Contactados y Seguimiento.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
