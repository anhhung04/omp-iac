// Pulumi program for the Floci AWS emulator.
//
// No endpoints appear here on purpose: the AWS SDK reads AWS_ENDPOINT_URL from
// the environment, so the same program runs against Floci locally and real AWS
// in CI with only an environment change. Use
// `iac_pulumi action=preview localCloud=floci-aws` to set that variable.
"use strict";

const aws = require("@pulumi/aws");

const bucket = new aws.s3.BucketV2("demo", {
  tags: { iac_mode: "cloud-emulation" },
});

new aws.s3.BucketVersioningV2("demo", {
  bucket: bucket.id,
  versioningConfiguration: { status: "Enabled" },
});

exports.bucketName = bucket.id;
