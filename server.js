const express = require('express');
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');
require('dotenv').config();

const app = express();

// Disable Mongoose Buffering (PENTING untuk Vercel)
mongoose.set('bufferCommands', false);

// Database Connection (Singleton for Vercel)
const connectDB = async () => {
    // Jika sudah terkoneksi (readyState 1), langsung return
    if (mongoose.connection.readyState === 1) return;

    // Jika sedang mencoba koneksi (readyState 2), tunggu sebentar
    if (mongoose.connection.readyState === 2) {
        console.log('Menunggu koneksi yang sedang berjalan...');
        await new Promise(resolve => setTimeout(resolve, 500));
        return connectDB();
    }

    try {
        const uri = process.env.MONGODB_URI;
        if (!uri) throw new Error('Variabel MONGODB_URI belum diisi di Vercel!');
        
        console.log('Memulai koneksi baru ke MongoDB...');
        await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        });
        console.log('Koneksi Berhasil!');
    } catch (err) {
        console.error('Gagal konek MongoDB:', err.message);
        throw err;
    }
};

// Middleware to ensure DB connection (Only for API routes)
app.use('/api', async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (err) {
        res.status(500).json({ 
            message: 'Gagal menyambung ke Database', 
            error: err.message,
            tip: 'Pastikan IP 0.0.0.0/0 sudah di-allow di MongoDB Atlas'
        });
    }
});

// Schema
const accountSchema = new mongoose.Schema({
    no: Number,
    kodeAkun: { type: String, required: true, unique: true },
    gmail: String,
    passwordGmail: String,
    passwordML: String,
    hargaBeli: Number,
    hargaJual: Number,
    keterangan: { type: String, default: 'Ready' }
});

const Account = mongoose.models.Account || mongoose.model('Account', accountSchema);

app.use(cors());
app.use(bodyParser.json());

// Session Configuration dengan MongoDB Store (Memperbaiki issue "tiba-tiba keluar")
app.use(session({
    secret: process.env.SESSION_SECRET || 'panzz-store-secret-key',
    resave: false,
    saveUninitialized: false, // Diubah jadi false untuk efisiensi
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        ttl: 24 * 60 * 60, // 1 Hari
        autoRemove: 'native'
    }),
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000, 
        secure: false, // Set true jika menggunakan HTTPS
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// Static files (This is important for Vercel)
app.use(express.static(path.join(process.cwd())));

// Home Route
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    res.sendFile(indexPath);
});

// Middleware
const checkAuth = (req, res, next) => {
    if (req.session && req.session.isAdmin) next();
    else res.status(401).json({ message: 'Unauthorized' });
};

// Login API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'password123';
    
    if (username === adminUser && password === adminPass) {
        req.session.isAdmin = true;
        res.json({ message: 'Success' });
    } else {
        res.status(401).json({ message: 'Username/Password Salah' });
    }
});

app.get('/api/auth-status', (req, res) => {
    res.json({ loggedIn: !!(req.session && req.session.isAdmin) });
});

app.get('/api/export-excel', checkAuth, async (req, res) => {
    try {
        const accounts = await Account.find().sort({ no: 1 });
        const data = accounts.map(acc => ({
            "No": acc.no,
            "Kode Akun": acc.kodeAkun,
            "Gmail": acc.gmail,
            "Password Gmail": acc.passwordGmail,
            "Password ML": acc.passwordML,
            "Harga Beli": acc.hargaBeli,
            "Harga Jual": acc.hargaJual,
            "Keterangan": acc.keterangan
        }));

        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Penjualan");
        
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Data_Penjualan_PanzzStore.xlsx');
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: 'Success' });
});

// Account APIs
app.get('/api/accounts', checkAuth, async (req, res) => {
    try {
        const data = await Account.find().sort({ no: 1 });
        res.json(data.map(acc => ({
            "No": acc.no,
            "Kode Akun": acc.kodeAkun,
            "Gmail": acc.gmail,
            "Password Gmail": acc.passwordGmail,
            "Password ML": acc.passwordML,
            "Harga Beli": acc.hargaBeli,
            "Harga Jual": acc.hargaJual,
            "Keterangan": acc.keterangan
        })));
    } catch (error) {
        res.status(500).json({ message: 'Gagal mengambil data: ' + error.message });
    }
});

app.get('/api/stats', checkAuth, async (req, res) => {
    try {
        const accounts = await Account.find();
        
        const stats = {
            totalAccounts: accounts.length,
            readyAccounts: accounts.filter(acc => acc.keterangan === 'Ready').length,
            soldAccounts: accounts.filter(acc => acc.keterangan === 'Sold').length,
            totalProfit: accounts
                .filter(acc => acc.keterangan === 'Sold')
                .reduce((sum, acc) => sum + ((acc.hargaJual || 0) - (acc.hargaBeli || 0)), 0),
            totalInvestment: accounts.reduce((sum, acc) => sum + (acc.hargaBeli || 0), 0),
            potentialRevenue: accounts
                .filter(acc => acc.keterangan === 'Ready')
                .reduce((sum, acc) => sum + (acc.hargaJual || 0), 0)
        };
        
        res.json(stats);
    } catch (error) {
        res.status(500).json({ message: 'Gagal mengambil statistik: ' + error.message });
    }
});

app.post('/api/accounts', checkAuth, async (req, res) => {
    try {
        const body = req.body;
        
        // Cek apakah Kode Akun sudah ada
        const existing = await Account.findOne({ kodeAkun: body["Kode Akun"] });
        if (existing) {
            return res.status(400).json({ message: 'Kode Akun sudah terdaftar!' });
        }

        if (!body.No) {
            const last = await Account.findOne().sort({ no: -1 });
            body.No = (last ? last.no : 0) + 1;
        }
        
        const newAcc = new Account({
            no: body.No,
            kodeAkun: body["Kode Akun"],
            gmail: body.Gmail,
            passwordGmail: body["Password Gmail"],
            passwordML: body["Password ML"],
            hargaBeli: body["Harga Beli"],
            hargaJual: body["Harga Jual"],
            keterangan: body.Keterangan
        });
        
        await newAcc.save();
        res.status(201).json(body);
    } catch (error) {
        res.status(500).json({ message: 'Gagal menyimpan: ' + error.message });
    }
});

app.put('/api/accounts/:kode', checkAuth, async (req, res) => {
    try {
        const kode = decodeURIComponent(req.params.kode).trim();
        const body = req.body;
        const updateData = {};
        
        // Map fields from body to schema fields
        if (body["Kode Akun"]) updateData.kodeAkun = body["Kode Akun"];
        if (body.Gmail) updateData.gmail = body.Gmail;
        if (body["Password Gmail"]) updateData.passwordGmail = body["Password Gmail"];
        if (body["Password ML"]) updateData.passwordML = body["Password ML"];
        if (body["Harga Beli"] !== undefined) updateData.hargaBeli = Number(body["Harga Beli"]);
        if (body["Harga Jual"] !== undefined) updateData.hargaJual = Number(body["Harga Jual"]);
        if (body.Keterangan) updateData.keterangan = body.Keterangan;
        // Support lowercase as fallback
        if (body.keterangan) updateData.keterangan = body.keterangan;

        const updated = await Account.findOneAndUpdate(
            { kodeAkun: kode },
            { $set: updateData },
            { new: true }
        );
        
        if (!updated) return res.status(404).json({ message: 'Data tidak ditemukan' });
        res.json(updated);
    } catch (error) {
        res.status(500).json({ message: 'Gagal update: ' + error.message });
    }
});

app.delete('/api/accounts/:kode', checkAuth, async (req, res) => {
    try {
        const result = await Account.deleteOne({ kodeAkun: decodeURIComponent(req.params.kode).trim() });
        if (result.deletedCount === 0) return res.status(404).json({ message: 'Data tidak ditemukan' });
        res.json({ message: 'Deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Gagal menghapus: ' + error.message });
    }
});

// For Vercel
module.exports = app;

// For Local
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Run on http://localhost:${PORT}`));
}
