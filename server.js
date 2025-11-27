// server.js - Version Cloud (Render + MySQL O2Switch)
const express = require('express');
const mysql = require('mysql2/promise'); // On utilise le driver MySQL
const cors = require('cors');
const bodyParser = require('body-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

// --- CONFIGURATION ---
// Sur Render, le PORT est fourni automatiquement par le système
const PORT = process.env.PORT || 3000; 

// On récupère les secrets depuis les variables d'environnement (Voir explications plus bas)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Tes identifiants O2Switch (On les mettra dans Render, pas en dur ici pour la sécurité)
const dbConfig = {
    host: process.env.DB_HOST,      // 109.234.162.77
    user: process.env.DB_USER,      // gile7808_val
    password: process.env.DB_PASSWORD, // levelup2025
    database: process.env.DB_NAME,  // gile7808_1clic
    port: 3306,
    connectTimeout: 20000 // On laisse le temps à la connexion de se faire
};

const app = express();
app.use(cors()); // Autorise ton extension Chrome à parler au serveur
app.use(bodyParser.json({ limit: '10mb' })); // Accepte les gros textes

// --- 1. CONNEXION À LA BASE DE DONNÉES ---
// Cette fonction crée une connexion à chaque requête pour éviter les coupures
async function getDB() {
    return await mysql.createConnection(dbConfig);
}

// Initialisation des tables au démarrage
(async () => {
    try {
        const connection = await getDB();
        console.log("✅ Connecté à MySQL sur O2Switch !");

        // Création de la table PROJETS
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS projects (
                id INT AUTO_INCREMENT PRIMARY KEY,
                url VARCHAR(255),
                status VARCHAR(50) DEFAULT 'en_cours',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Création de la table CONTENUS
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS contents (
                id INT AUTO_INCREMENT PRIMARY KEY,
                project_id INT,
                agent_name VARCHAR(50),
                hook TEXT,
                idea TEXT,
                source TEXT,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            )
        `);
        
        console.log("💾 Tables MySQL vérifiées/créées.");
        await connection.end();
    } catch (err) {
        console.error("❌ Erreur critique BDD :", err.message);
    }
})();

// --- 2. LOGIQUE IA (MULTI-AGENTS) ---
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash", 
    generationConfig: { responseMimeType: "application/json" } 
});

const AGENTS = [
    { name: "Polariser", role: "Provocateur", mission: "Trouve des opinions impopulaires." },
    { name: "Expertise", role: "Expert Technique", mission: "Donne des conseils pointus et concrets." },
    { name: "Divertir", role: "Humoriste", mission: "Tourne les problèmes en dérision." },
    { name: "Vente", role: "Copywriter", mission: "Fais le lien vers l'offre payante." }
];

async function runMultiAgents(projectId, siteText, comments) {
    console.log(`🧠 [IA] Démarrage analyse projet #${projectId}...`);
    
    // On lance tous les agents en parallèle
    const promises = AGENTS.map(async (agent) => {
        const prompt = `
        RÔLE : ${agent.role}. MISSION : ${agent.mission}
        
        CONTEXTE SITE : ${siteText.slice(0, 4000)}...
        CONTEXTE COMMENTAIRES : ${comments.slice(0, 4000)}...
        
        Tâche : Génère 2 idées de contenu.
        Format JSON requis : { "ideas": [{ "hook": "...", "content": "...", "source": "..." }] }
        `;
        
        try {
            const res = await model.generateContent(prompt);
            const json = JSON.parse(res.response.text());
            
            // On se reconnecte pour sauvegarder
            const conn = await getDB();
            for (const item of json.ideas) {
                await conn.execute(
                    `INSERT INTO contents (project_id, agent_name, hook, idea, source) VALUES (?, ?, ?, ?, ?)`,
                    [projectId, agent.name, item.hook, item.content, item.source]
                );
            }
            await conn.end();
        } catch (e) { console.error(`⚠️ Erreur Agent ${agent.name}:`, e.message); }
    });

    await Promise.all(promises);
    
    // Marquer comme terminé
    const conn = await getDB();
    await conn.execute('UPDATE projects SET status = "termine" WHERE id = ?', [projectId]);
    await conn.end();
    console.log(`✅ [IA] Projet #${projectId} terminé.`);
}

// --- 3. ROUTES API (Endpoints) ---

// Route 1 : Réception des données depuis l'extension
app.post('/api/analyze', async (req, res) => {
    const { url, siteText, comments } = req.body;
    console.log(`📥 [API] Reçu : ${url}`);

    try {
        const conn = await getDB();
        const [result] = await conn.execute('INSERT INTO projects (url) VALUES (?)', [url]);
        const projectId = result.insertId;
        await conn.end();

        // Lancer l'IA sans faire attendre la réponse HTTP
        runMultiAgents(projectId, siteText || "", comments || "");

        res.json({ success: true, projectId: projectId, message: "Agents lancés !" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Erreur connexion BDD" });
    }
});

// Route 2 : Liste des projets (pour le dashboard)
app.get('/api/projects', async (req, res) => {
    try {
        const conn = await getDB();
        const [rows] = await conn.execute('SELECT * FROM projects ORDER BY id DESC LIMIT 20');
        await conn.end();
        res.json(rows);
    } catch (e) { res.status(500).send(e.message); }
});

// Route 3 : Détails d'un projet
app.get('/api/projects/:id', async (req, res) => {
    try {
        const conn = await getDB();
        const [rows] = await conn.execute('SELECT * FROM contents WHERE project_id = ?', [req.params.id]);
        await conn.end();
        res.json(rows);
    } catch (e) { res.status(500).send(e.message); }
});

// Route 4 : Le Dashboard HTML (Visualisation)
app.get('/', (req, res) => {
    // Une interface simple servie directement par le serveur
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Dashboard Cloud</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: sans-serif; padding: 20px; background: #f0f2f5; }
            .container { max-width: 900px; margin: 0 auto; }
            .card { background: white; padding: 15px; margin-bottom: 10px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
            .tag { background: #e0e7ff; color: #4338ca; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; font-weight: bold; }
            .btn-project { display: block; width: 100%; text-align: left; padding: 10px; background: white; border: 1px solid #ddd; margin-bottom: 5px; cursor: pointer; }
            .btn-project:hover { background: #f9fafb; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>☁️ Dashboard Contenu (Render + O2Switch)</h1>
            <div id="list">Chargement...</div>
            <hr>
            <div id="details"></div>
        </div>
        <script>
            // L'URL s'adapte automatiquement
            const API = window.location.origin;

            async function loadProjects() {
                const res = await fetch(API + '/api/projects');
                const data = await res.json();
                document.getElementById('list').innerHTML = data.map(p => 
                    \`<button class="btn-project" onclick="loadDetails(\${p.id})">
                        📂 <strong>\${p.url}</strong> (\${p.status}) - \${new Date(p.created_at).toLocaleTimeString()}
                    </button>\`
                ).join('');
            }

            async function loadDetails(id) {
                document.getElementById('details').innerHTML = 'Chargement...';
                const res = await fetch(API + '/api/projects/' + id);
                const data = await res.json();
                
                if(data.length === 0) {
                     document.getElementById('details').innerHTML = '<p>Pas encore de contenu... les agents travaillent (ou erreur BDD).</p>';
                     return;
                }

                document.getElementById('details').innerHTML = data.map(c => \`
                    <div class="card">
                        <span class="tag">\${c.agent_name}</span>
                        <h3>\${c.hook}</h3>
                        <p>\${c.idea}</p>
                        <small style="color:gray">\${c.source}</small>
                    </div>
                \`).join('');
            }

            loadProjects();
            setInterval(loadProjects, 10000); // Rafraichissement auto
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
