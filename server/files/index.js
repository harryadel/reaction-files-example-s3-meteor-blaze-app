import { Meteor } from "meteor/meteor";
import { Mongo } from "meteor/mongo";
import { Random } from "meteor/random";
import { WebApp } from "meteor/webapp";
import { check } from "meteor/check";
import fetch from "node-fetch";
import {
  FileDownloadManager,
  FileRecord,
  RemoteUrlWorker,
  MongoFileCollection,
  TempFileStore,
  TempFileStoreWorker
} from "@reactioncommerce/file-collections";
import S3Store from "./s3-store/S3Store";

const stores = [
  new S3Store({
    name: "s3-store",
    objectACL: "public-read",
    async transformWrite(fileRecord) {
      // Either write your custom transformation code here, or re-use the one from the GridFSStore constructor
    }
  })
];

const tempStore = new TempFileStore({
  shouldAllowRequest(req) {
    const { type } = req.uploadMetadata;
    if (typeof type !== "string" || !type.startsWith("image/")) {
      console.info(`shouldAllowRequest received request to upload file of type "${type}" and denied it`); // eslint-disable-line no-console
      return false;
    }
    return true;
  }
});

const FilesCollection = new Mongo.Collection("FilesCollection");

const Files = new MongoFileCollection("Files", {
  // add more security here if the files should not be public
  allowGet: () => true,
  collection: FilesCollection.rawCollection(),
  makeNewStringID: () => Random.id(),
  stores,
  tempStore
});

Meteor.methods({
  async insertRemoteImage(url) {
    check(url, String);
    const fileRecord = await FileRecord.fromUrl(url, { fetch });
    return Files.insert(fileRecord, { raw: true });
  },
  async insertUploadedImage(fileRecordDocument) {
    check(fileRecordDocument, Object);
    return Files._insert(fileRecordDocument);
  },
  async removeImage(id) {
    const fileRecord = await Files.findOne(id);
    if (!fileRecord) throw new Meteor.Error("not-found", `No FileRecord has ID ${id}`);
    const result = await Files.remove(fileRecord);
    return result;
  },
  async removeAllImages() {
    const files = await Files.find();
    const result = await Promise.all(files.map((fileRecord) => Files.remove(fileRecord)));
    return result;
  },
  async cloneImage(id) {
    const fileRecord = await Files.findOne(id);
    if (!fileRecord) throw new Meteor.Error("not-found", `No FileRecord has ID ${id}`);

    // The side effect of this call should be that a new file record now
    // exists with data in both stores, and will be autopublished to the client.
    await fileRecord.fullClone();
  }
});

const downloadManager = new FileDownloadManager({
  collections: [Files],
  headers: {
    get: {
      "Cache-Control": "public, max-age=31536000"
    }
  }
});

const remoteUrlWorker = new RemoteUrlWorker({ fetch, fileCollections: [Files] });
remoteUrlWorker.start();

const uploadWorker = new TempFileStoreWorker({ fileCollections: [Files] });
uploadWorker.start();

WebApp.connectHandlers.use("/juicy/uploads", (req, res) => {
  req.baseUrl = "/juicy/uploads"; // tus relies on this being set
  tempStore.connectHandler(req, res);
});

WebApp.connectHandlers.use("/files", downloadManager.connectHandler);
