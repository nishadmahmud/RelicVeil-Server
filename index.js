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

    // GET: Get artifacts by user email
    app.get("/api/artifacts/user/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const artifacts = await artifactsCollection
          .find({
            adderEmail: email,
          })
          .toArray();
        res.json(artifacts);
      } catch (error) {
        console.error("Error fetching user artifacts:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch user artifacts",
        });
      }
    });

    // GET: Get single artifact by ID
    app.get("/api/artifacts/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const artifact = await artifactsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!artifact) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found",
          });
        }

        res.json(artifact);
      } catch (error) {
        console.error("Error fetching artifact:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch artifact",
        });
      }
    });

    // PATCH: Update like count
    app.patch("/api/artifacts/:id/like", async (req, res) => {
      try {
        const id = req.params.id;
        const { userEmail } = req.body;

        if (!userEmail) {
          return res.status(400).json({
            success: false,
            message: "User email is required",
          });
        }

        const result = await artifactsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $inc: { likeCount: 1 },
            $addToSet: { likedBy: userEmail }, // Add user to likedBy array if not already present
          }
        );

        if (result.modifiedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found",
          });
        }

        res.json({
          success: true,
          message: "Like count updated successfully",
        });
      } catch (error) {
        console.error("Error updating like count:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update like count",
        });
      }
    });

    // PATCH: Update dislike (decrease like count)
    app.patch("/api/artifacts/:id/dislike", async (req, res) => {
      try {
        const id = req.params.id;
        const { userEmail } = req.body;

        if (!userEmail) {
          return res.status(400).json({
            success: false,
            message: "User email is required",
          });
        }

        // First get the current like count and check if user has liked
        const artifact = await artifactsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!artifact) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found",
          });
        }

        // Only decrease if like count is greater than 0 and user has liked
        if (artifact.likeCount > 0 && artifact.likedBy?.includes(userEmail)) {
          const result = await artifactsCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $inc: { likeCount: -1 },
              $pull: { likedBy: userEmail }, // Remove user from likedBy array
            }
          );

          if (result.modifiedCount === 0) {
            return res.status(404).json({
              success: false,
              message: "Artifact not found",
            });
          }
        }

        res.json({
          success: true,
          message: "Like count updated successfully",
        });
      } catch (error) {
        console.error("Error updating like count:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update like count",
        });
      }
    });

    // GET: Get user's liked artifacts
    app.get("/api/artifacts/liked/:userEmail", async (req, res) => {
      try {
        const userEmail = req.params.userEmail;
        const likedArtifacts = await artifactsCollection
          .find({ likedBy: userEmail })
          .toArray();

        res.json(likedArtifacts);
      } catch (error) {
        console.error("Error fetching liked artifacts:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch liked artifacts",
        });
      }
    });

    // DELETE: Delete an artifact
    app.delete("/api/artifacts/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const result = await artifactsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found",
          });
        }

        res.json({
          success: true,
          message: "Artifact deleted successfully",
        });
      } catch (error) {
        console.error("Error deleting artifact:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete artifact",
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
