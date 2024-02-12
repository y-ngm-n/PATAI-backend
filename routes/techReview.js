// import modules
const express = require("express");
const dotenv = require("dotenv");
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const pdf = require("pdf-creator-node");
const fs = require("fs");

// import files
const { techPrompt, lawPrompt } = require("../prompts/techReviewPrompt");
// const data = require("./data.json");

// config
dotenv.config();
const router = express.Router();
// azure
const client = new OpenAIClient(process.env.AZURE_ENDPOINT, new AzureKeyCredential(process.env.AZURE_KEY));
// pinecone
const pc = new Pinecone({ apiKey: process.env.PINECONE_KEY });
const index = pc.index(process.env.PINECONE_INDEX);
// pdf creator
const reportTemplate = fs.readFileSync(`${__dirname}/../templates/techReviewTemplate.html`, "utf-8");
const reportOption = {
  format: "A4",
  orientation: "portrait",
  border: "10mm"
};


// sentence -> embedding
const getEmbedding = async (t) => {
  try {
    const embedding = await client.getEmbeddings(process.env.AZURE_EMBEDDING, [t]);
    return embedding.data[0].embedding;
  } catch (err) { console.error(err); }
}

// 선행기술 DB 검토
const queryToTechIndex = async (userPrompt) => {
  try {
    const embedding = await getEmbedding(userPrompt);
    const result = await index.namespace("prior_patent").query({
      topK: 5,
      vector: embedding,
      includeMetadata: true
    });
    console.log(JSON.stringify(result.matches[0].metadata));
    return result;
  } catch (err) { console.error(err); }
}

// 특허법 DB 검토
const queryToLawIndex = async (techResponse) => {
  const embedding = await getEmbedding(techResponse);
  const result = await index.namespace("patent_law").query({
    topK: 3,
    vector: embedding,
    includeMetadata: true
  });
  console.log(result.matches[0].metadata);
  return result;
}

// 답변 생성
const generateAnswer = async (userPrompt) => {
  try {
    // 선행기술 DB 탐색 결과
    const techReviewResult = await queryToTechIndex(userPrompt);

    // 대화 생성
    const dialogue = [
      {
        role: "system",
        content: techPrompt
        + JSON.stringify(techReviewResult.matches[0].metadata)
        + JSON.stringify(techReviewResult.matches[1].metadata)
        + JSON.stringify(techReviewResult.matches[2].metadata)
        + JSON.stringify(techReviewResult.matches[3].metadata)
        + JSON.stringify(techReviewResult.matches[4].metadata)
      },
      { role: "system", content: lawPrompt },
      { role: "user", content: userPrompt }
    ];

    // 선행기술 검토 답변
    const techResponse = await client.getChatCompletions(process.env.AZURE_GPT, dialogue);
    console.log(techResponse.choices[0].message);

    // 특허법 DB 탐색 결과
    const lawReviewResult = await queryToLawIndex(techResponse.choices[0].message.content);

    // 대화 추가
    dialogue.push(techResponse.choices[0].message);
    dialogue.push({
      role: "system",
      content: lawPrompt
      + JSON.stringify(lawReviewResult.matches[0].metadata)
      + JSON.stringify(lawReviewResult.matches[1].metadata)
      + JSON.stringify(lawReviewResult.matches[2].metadata)
    });

    // 특허법 검토 답변
    const lawResponse = await client.getChatCompletions(process.env.AZURE_GPT, dialogue);
    return lawResponse.choices[0].message;
  } catch (err) { console.error(err); }
}

// 보고서 생성
const generateReport = async (body, userPrompt) => {
  try {
    // 선행기술 DB 탐색 결과
    const techReviewSearchResult = await queryToTechIndex(userPrompt);

    // 대화 생성
    const dialogue = [
      {
        role: "system",
        content: techPrompt
        + JSON.stringify(techReviewSearchResult.matches[0].metadata)
        + JSON.stringify(techReviewSearchResult.matches[1].metadata)
        + JSON.stringify(techReviewSearchResult.matches[2].metadata)
        // + JSON.stringify(techReviewSearchResult.matches[3].metadata)
        // + JSON.stringify(techReviewSearchResult.matches[4].metadata)
      },
      { role: "system", content: lawPrompt },
      { role: "user", content: userPrompt }
    ];

    // 답변
    const response = await client.getChatCompletions(process.env.AZURE_GPT, dialogue);
    const date = new Date();

    // 보고서 항목
    const data = {
      info: {
        registration: "",
        registerDate: body.date,
        company: body.organization,
        nowDate: `${date.getFullYear()}년 ${date.getMonth()}월 ${date.getDate()}일`,
        name: body.name,
        report: "등록가능성 진단보고서",
        summary: body.description
      },
      result: {
        otherPatents: [
          {
            index: techReviewSearchResult.matches[0].id,
            registration: techReviewSearchResult.matches[0].metadata.registration,
            registerDate: "",
            company: "",
            name: techReviewSearchResult.matches[0].metadata.name,
            similarity: ""
          },
          {
            index: techReviewSearchResult.matches[1].id,
            registration: techReviewSearchResult.matches[1].metadata.registration,
            registerDate: "",
            company: "",
            name: techReviewSearchResult.matches[1].metadata.name,
            similarity: ""
          },
          {
            index: techReviewSearchResult.matches[2].id,
            registration: techReviewSearchResult.matches[2].metadata.registration,
            registerDate: "",
            company: "",
            name: techReviewSearchResult.matches[2].metadata.name,
            similarity: ""
          },
        ],
        opinion: response.choices[0].message.content,
        probability: ""
      }
    }

    // 보고서 생성
    const document = {
      html: reportTemplate,
      data: { info: data.info, result: data.result },
      path: "./output.pdf",
      type: "buffer"
    };
    const result = await pdf.create(document, reportOption);
    return result;
  } catch (err) { console.error(err); }
}


// routers
router.post("/", async (req, res) => {
  const { body } = req;
  const userPrompt = JSON.stringify(body);
  const result = await generateReport(body, userPrompt);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=report.pdf");
  res.send(result);
  // console.log(result);
  // res.json(result.content);
});


module.exports = router;