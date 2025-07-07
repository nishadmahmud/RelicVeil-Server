const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
} catch (error) {
  console.error('Error initializing Firebase Admin:', error);
  throw new Error('Failed to initialize Firebase Admin SDK');
}


const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);
  
  if (err.name === 'UnauthorizedError' || err.code === 'auth/id-token-expired') {
    return res.status(401).json({ 
      success: false, 
      message: 'Invalid or expired token' 
    });
  }
  
  if (err.code === 'auth/insufficient-permission') {
    return res.status(403).json({ 
      success: false, 
      message: 'Insufficient permissions' 
    });
  }
  
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error' 
  });
};

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers?.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        message: "Unauthorized access" 
      });
    }

    const token = authHeader.split(' ')[1];
    try {
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.user = decodedToken;
      next();
    } catch (error) {
      if (error.code === 'auth/id-token-expired') {
        return res.status(401).json({ 
          success: false, 
          message: 'Token expired' 
        });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

const verifyOwnership = async (req, res, next) => {
  try {
    const userEmail = req.user.email;
    const artifact = await artifactsCollection.findOne({ 
      _id: new ObjectId(req.params.id) 
    });
    
    if (!artifact) {
      return res.status(404).json({ 
        success: false, 
        message: 'Artifact not found' 
      });
    }
    
    if (artifact.adderEmail !== userEmail) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have permission to modify this artifact' 
      });
    }
    
    req.artifact = artifact;
    next();
  } catch (error) {
    next(error);
  }
};

app.use(cors());
app.use(express.json());

app.use(errorHandler);

app.get("/api/test-auth", verifyToken, async (req, res) => {
  try {
    res.json({
      message: "Authentication successful",
      user: {
        email: req.user.email,
        uid: req.user.uid,
        emailVerified: req.user.email_verified
      }
    });
  } catch (error) {
    console.error("Test auth error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@ph-cluster.8kwdmtt.mongodb.net/?retryWrites=true&w=majority&appName=PH-Cluster`;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function run() {
  try {
    console.log("Connected to MongoDB");

    const db = client.db("artifactsDB");
    const artifactsCollection = db.collection("artifacts");

    try {
        await artifactsCollection.dropIndex("name_text_description_text_type_text_presentLocation_text");
    } catch (error) {
        console.log("No existing text index to drop");
    }

    await artifactsCollection.createIndex(
        { 
            name: "text", 
            description: "text", 
            type: "text", 
            presentLocation: "text" 
        },
        { 
            weights: {
                name: 10,
                type: 5,
                presentLocation: 5,
                description: 1
            },
            name: "artifact_search_index"
        }
    );

    app.get("/api/artifacts/search", async (req, res) => {
        try {
            const searchQuery = req.query.q;
            console.log("Search query received:", searchQuery);
            
            if (!searchQuery || searchQuery.trim() === '') {
                return res.json([]);
            }

            const searchRegex = new RegExp(searchQuery, 'i');

            const result = await artifactsCollection.find({
                $or: [
                    { name: searchRegex },
                    { description: searchRegex },
                    { type: searchRegex },
                    { presentLocation: searchRegex }
                ]
            }).toArray();

            console.log(`Found ${result.length} results for query: ${searchQuery}`);
            
            res.json(result);
        } catch (error) {
            console.error("Error searching artifacts:", error);
            res.status(500).json({
                success: false,
                message: "Failed to search artifacts",
                error: error.message
            });
        }
    });

    app.get("/api/artifacts/top-liked", async (req, res) => {
      try {
        const result = await artifactsCollection.aggregate([
          { $sort: { likeCount: -1 } },
          { $limit: 6 }
        ]).toArray();
        
        return res.json(result);
      } catch (error) {
        console.error('Error in top-liked:', error);
        return res.status(500).json({ message: 'Server error' });
      }
    });

    app.post("/api/artifacts", verifyToken, async (req, res) => {
      try {
        const artifact = req.body;
        artifact.likeCount = 0;
        artifact.addedDate = new Date();
        artifact.adderEmail = req.user.email;

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

    app.get("/api/artifacts/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid artifact ID format"
          });
        }

        const artifact = await artifactsCollection.findOne({
          _id: new ObjectId(id)
        });

        if (!artifact) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found"
          });
        }

        res.status(200).json(artifact);
      } catch (error) {
        console.error("Error fetching artifact:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch artifact",
          error: error.message
        });
      }
    });

    app.patch("/api/artifacts/:id/like", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.user.email;

        const result = await artifactsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $inc: { likeCount: 1 },
            $addToSet: { likedBy: userEmail },
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

    app.patch("/api/artifacts/:id/dislike", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.user.email;

        const artifact = await artifactsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!artifact) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found",
          });
        }

        if (artifact.likeCount > 0 && artifact.likedBy?.includes(userEmail)) {
          const result = await artifactsCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $inc: { likeCount: -1 },
              $pull: { likedBy: userEmail },
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

    app.get("/api/artifacts/liked/:userEmail", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;
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

    app.get("/api/artifacts/user/:email", verifyToken, async (req, res) => {
      try {
        const email = req.user.email;
        
        const artifacts = await artifactsCollection
          .find({ adderEmail: email })
          .toArray();

        console.log(`Found ${artifacts.length} artifacts for user ${email}`);
        
        return res.status(200).json(artifacts);
      } catch (error) {
        console.error("Error fetching user artifacts:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to fetch user artifacts"
        });
      }
    });

    app.patch("/api/artifacts/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const updates = req.body;
        const userEmail = req.user.email;

        const artifact = await artifactsCollection.findOne({
          _id: new ObjectId(id),
          adderEmail: userEmail
        });

        if (!artifact) {
          return res.status(403).json({
            success: false,
            message: "You don't have permission to update this artifact"
          });
        }

        delete updates.likeCount;
        delete updates.likedBy;
        delete updates.adderName;
        delete updates.adderEmail;

        const result = await artifactsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updates }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found"
          });
        }

        res.json({
          success: true,
          message: "Artifact updated successfully"
        });
      } catch (error) {
        console.error("Error updating artifact:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update artifact"
        });
      }
    });

    app.delete("/api/artifacts/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.user.email;

        const artifact = await artifactsCollection.findOne({
          _id: new ObjectId(id),
          adderEmail: userEmail
        });

        if (!artifact) {
          return res.status(403).json({
            success: false,
            message: "You don't have permission to delete this artifact"
          });
        }

        const result = await artifactsCollection.deleteOne({
          _id: new ObjectId(id)
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found"
          });
        }

        res.json({
          success: true,
          message: "Artifact deleted successfully"
        });
      } catch (error) {
        console.error("Error deleting artifact:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete artifact"
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

