const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@ph-cluster.8kwdmtt.mongodb.net/?retryWrites=true&w=majority&appName=PH-Cluster`;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function run() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db("artifactsDB");
    const artifactsCollection = db.collection("artifacts");

    // POST: Add a new artifact
    app.post("/api/artifacts", async (req, res) => {
      try {
        const artifact = req.body;
        // Add likeCount and timestamp
        artifact.likeCount = 0;
        artifact.addedDate = new Date();

        const result = await artifactsCollection.insertOne(artifact);
        res.status(201).json({
          success: true,
          message: "Artifact added successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error adding artifact:", error);
        res.status(500).json({
          success: false,
          message: "Failed to add artifact",
        });
      }
    });

    // GET: Get all artifacts
    app.get("/api/artifacts", async (req, res) => {
      try {
        const artifacts = await artifactsCollection.find().toArray();
        res.json(artifacts);
      } catch (error) {
        console.error("Error fetching artifacts:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch artifacts",
        });
      }
    });

    app.get("/", (req, res) => {
      res.send("Artifacts Server is running!");
    });
  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
